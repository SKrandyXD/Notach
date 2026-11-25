import { z } from "zod";
export * from "./summary-document.js";
export {
  resolveLocalServices,
  parseServiceAuthority,
  isServiceAuthority,
  type LocalServices,
  type LocalServiceEnvironment,
  type LocalServicePorts,
} from "./local-services.js";

export const NoteRoleSchema = z.enum(["owner", "editor", "viewer"]);
export const NoteStatusSchema = z.enum(["active", "archived"]);
export const SummaryLengthSchema = z.enum(["short", "medium", "detailed"]);
export const SummaryOptionsSchema = z.object({
  language: z.enum(["uk", "en"]).default("uk"),
  length: SummaryLengthSchema.default("short"),
  generateTags: z.boolean().default(true),
  generateTitle: z.boolean().optional(),
});

export const SummaryContentSchema = z.object({
  shortText: z.string().trim().min(1).max(4000),
  keyPoints: z.array(z.string().trim().min(1).max(600)).min(1).max(15),
  tags: z.array(z.string().trim().min(1).max(40)).max(10),
  suggestedTitle: z.string().trim().min(1).max(120).optional(),
});

export const SummarizeRequestSchema = z.object({
  noteId: z.string().min(1).max(128),
  revision: z.number().int().min(1),
  requestId: z.string().uuid(),
  modelId: z.string().trim().min(1).max(128).optional(),
  options: SummaryOptionsSchema,
});

export const SaveSummaryRequestSchema = z.object({
  sourceRevision: z.number().int().min(1),
  summary: SummaryContentSchema,
  requestId: z.string().uuid(),
  isUserEdited: z.boolean().optional(),
  baseSummaryId: z.string().trim().min(1).max(128).optional(),
});

export const FeedbackRequestSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(1000).default(""),
  accepted: z.boolean(),
});

export const ShareRequestSchema = z.object({
  email: z.string().trim().email().max(320),
  role: z.enum(["viewer", "editor"]),
});

export const NoteWriteSchema = z.object({
  title: z.string().trim().max(120).default("Без назви"),
  content: z.string().max(50000),
  tags: z.array(z.string().trim().min(1).max(30)).max(20),
  status: NoteStatusSchema.default("active"),
});

export type NoteRole = z.infer<typeof NoteRoleSchema>;
export type NoteStatus = z.infer<typeof NoteStatusSchema>;
export type SummaryLength = z.infer<typeof SummaryLengthSchema>;
export type SummaryOptions = z.infer<typeof SummaryOptionsSchema>;
export type SummaryContent = z.infer<typeof SummaryContentSchema>;
export type NoteWrite = z.infer<typeof NoteWriteSchema>;

export interface SummaryModelOption {
  id: string;
  label: string;
}

export interface SummaryModelCatalog {
  models: SummaryModelOption[];
  defaultModelId: string;
}

export interface SummarizationLimits {
  provider: "mock" | "gemini";
  serverTime: string;
  budget: {
    currency: "USD";
    limitUsd: number;
    spentUsd: number;
    reservedUsd: number;
    remainingUsd: number;
    windowSeconds: 3600;
    windowStartedAt: string;
    resetsAt: string;
    scope: "user";
    inputTokens: number;
    outputTokens: number;
    thinkingTokens: number;
    unreportedCalls: number;
  };
  pricing: {
    modelId: string;
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
    cachedInputUsdPerMillionTokens: number;
  } | null;
  text: { maxCharacters: number };
  generation: { deadlineSeconds: number; maxConcurrentPerNote: number };
  providerQuota: { available: false };
}

export interface Note {
  id: string;
  ownerUid: string;
  title: string;
  titleNormalized: string;
  content: string;
  tags: string[];
  revision: number;
  status: NoteStatus;
  summaryCount?: number;
  favorite?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Summary extends SummaryContent {
  id: string;
  noteId: string;
  sourceRevision: number;
  suggestedTags: string[];
  modelId: string;
  promptVersion: string;
  durationMs: number;
  generationStatus: "ready" | "failed";
  isUserEdited: boolean;
  baseSummaryId?: string;
  createdAt: Date;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}
export interface ApiFailure {
  ok: false;
  error: { code: string; message: string; requestId?: string };
}

export function normalizeTitle(value: string): string {
  return value.normalize("NFC").trim().toLocaleLowerCase("uk-UA");
}

export function normalizeTags(values: string[]): string[] {
  const seen = new Set<string>();
  return values
    .map((tag) =>
      tag.normalize("NFC").trim().replace(/^#/, "").toLocaleLowerCase("uk-UA"),
    )
    .filter((tag) => tag.length > 0 && !seen.has(tag) && Boolean(seen.add(tag)))
    .slice(0, 20);
}

export function splitIntoChunks(
  text: string,
  maxWords = 1800,
  maxChunks = 8,
): string[] {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  let count = 0;
  const wordCount = (value: string) =>
    value.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  const append = (piece: string) => {
    const normalized = piece.trim();
    const words = wordCount(normalized);
    if (current && count + words > maxWords) {
      chunks.push(current);
      current = "";
      count = 0;
    }
    current = current ? `${current} ${normalized}` : normalized;
    count += words;
  };
  for (const paragraph of paragraphs.length ? paragraphs : [text.trim()]) {
    const sentences = paragraph.match(/[^.!?]+[.!?]+|[^.!?]+$/gu) ?? [
      paragraph,
    ];
    for (const sentence of sentences) {
      if (wordCount(sentence) <= maxWords) {
        append(sentence);
      } else {
        const words = sentence.match(/\S+/gu) ?? [sentence];
        for (let offset = 0; offset < words.length; offset += maxWords)
          append(words.slice(offset, offset + maxWords).join(" "));
      }
    }
  }
  if (current) chunks.push(current);
  if (chunks.length > maxChunks) throw new Error("NOTE_TOO_LONG");
  return chunks.filter(Boolean);
}
