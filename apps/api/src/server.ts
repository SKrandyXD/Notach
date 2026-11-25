import { resolve } from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), "../../backend/.env") });
dotenv.config({ path: resolve(process.cwd(), ".env") });

const { env } = await import("./config/env.js");
if (env.USE_FIREBASE_EMULATORS) {
  process.env.FIRESTORE_EMULATOR_HOST = env.FIRESTORE_EMULATOR_HOST;
  process.env.FIREBASE_AUTH_EMULATOR_HOST = env.FIREBASE_AUTH_EMULATOR_HOST;
} else {
  delete process.env.FIRESTORE_EMULATOR_HOST;
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
}

const [
  { initializeApp, applicationDefault },
  { getAuth },
  { getFirestore },
  { createApp },
  { FirestoreNoteRepository },
  { GeminiAdapter },
  { MockSummarizationAdapter },
] = await Promise.all([
  import("firebase-admin/app"),
  import("firebase-admin/auth"),
  import("firebase-admin/firestore"),
  import("./app.js"),
  import("./firebase/repository.js"),
  import("./adapters/gemini-adapter.js"),
  import("./adapters/mock-adapter.js"),
]);

initializeApp({
  ...(env.USE_FIREBASE_EMULATORS ? {} : { credential: applicationDefault() }),
  projectId: env.FIREBASE_PROJECT_ID,
});
const repository = new FirestoreNoteRepository(getFirestore(), getAuth());
const { FirestoreBudgetStore, HourlyBudget } =
  await import("./services/ai-budget.js");
const budget = new HourlyBudget(
  new FirestoreBudgetStore(getFirestore()),
  env.AI_HOURLY_BUDGET_USD,
);
const summarizer =
  env.AI_PROVIDER === "gemini"
    ? new GeminiAdapter(env.GEMINI_API_KEY, env.GEMINI_MODEL, {
        timeoutMs: env.AI_TIMEOUT_MS,
        requireUsageAccounting: true,
      })
    : new MockSummarizationAdapter();

const app = createApp({
  verifyToken: async (token) => {
    try {
      const decoded = await getAuth().verifyIdToken(token);
      return { uid: decoded.uid };
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code: unknown }).code)
          : "unknown";
      console.warn(
        JSON.stringify({
          event: "firebase_token_verification_failed",
          code,
          useEmulators: env.USE_FIREBASE_EMULATORS,
        }),
      );
      throw error;
    }
  },
  repository,
  summarizer,
  budget,
  config: {
    corsOrigins: env.CORS_ORIGIN.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    maxNoteChars: env.MAX_NOTE_CHARS,
    modelId: env.GEMINI_MODEL,
    promptVersion: env.AI_PROMPT_VERSION,
    provider: env.AI_PROVIDER,
  },
});

app.listen(env.PORT, () =>
  console.info(`Notach API listening on port ${env.PORT}.`),
);
