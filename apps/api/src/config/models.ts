import { z } from "zod";
import type { SummaryModelCatalog } from "@notach/shared";

// Only text-generation models supported by this adapter may be selected.
// Keep this registry on the server; the browser receives its public catalog.
const GEMINI_MODELS = [
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
] as const;

export const DEFAULT_GEMINI_MODEL_ID = GEMINI_MODELS[0].id;
export const GeminiModelIdSchema = z.enum(
  GEMINI_MODELS.map((model) => model.id),
);

export function getSummaryModelCatalog(
  provider: "mock" | "gemini",
  defaultModelId: string,
): SummaryModelCatalog {
  if (provider === "mock") {
    return {
      models: [{ id: "notach-mock-v1", label: "Notach Mock" }],
      defaultModelId: "notach-mock-v1",
    };
  }

  const selectedDefault = GeminiModelIdSchema.parse(defaultModelId);
  return {
    models: GEMINI_MODELS.map((model) => ({ ...model })),
    defaultModelId: selectedDefault,
  };
}
