import { resolve } from "node:path";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { normalizeProviderError } from "../services/provider-errors.js";
import {
  GeminiAdapter,
  summaryResponseJsonSchema,
  summarySystemInstruction,
} from "../adapters/gemini-adapter.js";
import { SummaryContentSchema } from "@notach/shared";
import { SummarizationError } from "../domain.js";

dotenv.config({
  path: resolve(process.cwd(), "../../backend/.env"),
  quiet: true,
});
dotenv.config({ path: resolve(process.cwd(), ".env"), quiet: true });

const { env } = await import("../config/env.js");
if (!env.GEMINI_API_KEY) {
  console.error(
    JSON.stringify({
      ok: false,
      code: "AI_AUTH_FAILED",
      reason: "GEMINI_API_KEY_MISSING",
    }),
  );
  process.exitCode = 1;
} else {
  try {
    if (process.argv.includes("--interactions")) {
      const startedAt = Date.now();
      const response = await new GoogleGenAI({
        apiKey: env.GEMINI_API_KEY,
      }).interactions.create(
        {
          model: env.GEMINI_MODEL,
          input:
            "Summarize in Ukrainian: The project meeting is scheduled for 12 November at 10:00. " +
            "Olena will prepare the agenda. The team will review the notes on Friday.",
          system_instruction: summarySystemInstruction,
          generation_config: { thinking_level: "low" },
          response_format: {
            type: "text",
            mime_type: "application/json",
            schema: summaryResponseJsonSchema,
          },
          store: false,
          stream: false,
          background: false,
        },
        {
          signal: AbortSignal.timeout(env.AI_TIMEOUT_MS),
          timeout_ms: env.AI_TIMEOUT_MS,
          retries: { strategy: "none" },
        },
      );
      let summary;
      try {
        summary = SummaryContentSchema.parse(
          JSON.parse(response.output_text ?? ""),
        );
      } catch {
        throw new SummarizationError("AI_INVALID_RESPONSE");
      }
      if (response.status !== "completed")
        throw new SummarizationError("AI_INVALID_RESPONSE");
      console.info(
        JSON.stringify({
          ok: true,
          api: "interactions",
          model: env.GEMINI_MODEL,
          validSummary: true,
          keyPoints: summary.keyPoints.length,
          tags: summary.tags.length,
          durationMs: Date.now() - startedAt,
        }),
      );
    } else if (process.argv.includes("--list")) {
      const page = await new GoogleGenAI({
        apiKey: env.GEMINI_API_KEY,
      }).models.list({
        config: { pageSize: 100, abortSignal: AbortSignal.timeout(15000) },
      });
      const models: string[] = [];
      for await (const model of page) {
        if (model.name && model.supportedActions?.includes("generateContent"))
          models.push(model.name);
        if (models.length >= 100) break;
      }
      console.info(JSON.stringify({ ok: true, models }));
    } else if (process.argv.includes("--transport")) {
      const modelId = env.GEMINI_MODEL.replace(/^models\//, "");
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": env.GEMINI_API_KEY,
          },
          body: "{}",
          signal: AbortSignal.timeout(15000),
        },
      );
      // Missing contents must be rejected before generation; HTTP 400 confirms POST transport works.
      if (response.status === 400)
        console.info(
          JSON.stringify({
            ok: true,
            postEndpointReachable: true,
            upstreamStatus: response.status,
            generatesContent: false,
          }),
        );
      else throw { status: response.status, message: await response.text() };
    } else if (process.argv.includes("--generate")) {
      const startedAt = Date.now();
      let call = 0;
      const diagnosticFetch: typeof fetch = async (input, init) => {
        const requestNumber = ++call;
        const requestStart = Date.now();
        console.info(
          JSON.stringify({ event: "ai_http_started", requestNumber }),
        );
        const response = await fetch(input, init);
        console.info(
          JSON.stringify({
            event: "ai_http_headers",
            requestNumber,
            status: response.status,
            durationMs: Date.now() - requestStart,
          }),
        );
        return response;
      };
      const summary = await new GeminiAdapter(
        env.GEMINI_API_KEY,
        env.GEMINI_MODEL,
        {
          timeoutMs: env.AI_TIMEOUT_MS,
          fetch: diagnosticFetch,
        },
      ).summarize(
        "The project meeting is scheduled for 12 November at 10:00. " +
          "Olena will prepare the agenda. The team will review the notes on Friday.",
        { language: "uk", length: "short", generateTags: true },
        { requestId: "synthetic-ai-check" },
      );
      console.info(
        JSON.stringify({
          ok: true,
          model: env.GEMINI_MODEL,
          source: "synthetic",
          validSummary: true,
          keyPoints: summary.keyPoints.length,
          tags: summary.tags.length,
          durationMs: Date.now() - startedAt,
        }),
      );
    } else {
      // Metadata only: sends no note content and generates no model output.
      const model = await new GoogleGenAI({
        apiKey: env.GEMINI_API_KEY,
      }).models.get({
        model: env.GEMINI_MODEL,
        config: { abortSignal: AbortSignal.timeout(15000) },
      });
      console.info(
        JSON.stringify({
          ok: true,
          model: model.name ?? env.GEMINI_MODEL,
          supportedActions: model.supportedActions ?? [],
        }),
      );
    }
  } catch (error) {
    const failure = normalizeProviderError(error);
    console.error(
      JSON.stringify({
        ok: false,
        model: env.GEMINI_MODEL,
        code: failure.code,
        upstreamStatus: failure.upstreamStatus,
        providerReason: failure.providerReason,
      }),
    );
    process.exitCode = 1;
  }
}
