import { z } from "zod";
import { isServiceAuthority, resolveLocalServices } from "@notach/shared";
import { DEFAULT_GEMINI_MODEL_ID, GeminiModelIdSchema } from "./models.js";

const services = resolveLocalServices(process.env);
const serviceAuthoritySchema = z
  .string()
  .refine(isServiceAuthority, "Expected host:port without a protocol.");

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(services.apiPort),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  FIREBASE_PROJECT_ID: z.string().min(1).default("demo-notach"),
  USE_FIREBASE_EMULATORS: z
    .string()
    .default("false")
    .transform((value) => value.toLowerCase() === "true"),
  FIRESTORE_EMULATOR_HOST: serviceAuthoritySchema.default(
    services.firestoreEmulatorAuthority,
  ),
  FIREBASE_AUTH_EMULATOR_HOST: serviceAuthoritySchema.default(
    services.authEmulatorAuthority,
  ),
  AI_PROVIDER: z.enum(["mock", "gemini"]).default("mock"),
  GEMINI_API_KEY: z.string().optional().default(""),
  GEMINI_MODEL: GeminiModelIdSchema.default(DEFAULT_GEMINI_MODEL_ID),
  AI_PROMPT_VERSION: z.string().default("notach-summary-v1"),
  CORS_ORIGIN: z
    .string()
    .default(services.webOrigin)
    .refine(
      (value) =>
        value.split(",").every((origin) => {
          try {
            const url = new URL(origin.trim());
            return (
              ["http:", "https:"].includes(url.protocol) &&
              url.origin === origin.trim()
            );
          } catch {
            return false;
          }
        }),
      "Expected comma-separated HTTP origins.",
    ),
  MAX_NOTE_CHARS: z.coerce.number().int().min(1000).max(50000).default(50000),
  AI_HOURLY_BUDGET_USD: z.coerce.number().positive().max(100).default(0.1),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(180000).default(120000),
});

const result = envSchema.safeParse(process.env);
if (!result.success)
  throw new Error(
    `Invalid API configuration: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
  );
if (result.data.AI_PROVIDER === "gemini" && !result.data.GEMINI_API_KEY) {
  throw new Error("AI_PROVIDER=gemini requires GEMINI_API_KEY.");
}

export const env = result.data;
