import type { SummaryContent, SummaryOptions } from "@notach/shared";

export interface NoteDocument {
  ownerUid: string;
  title: string;
  titleNormalized: string;
  content: string;
  tags: string[];
  revision: number;
  status: "active" | "archived";
  summaryCount?: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type AccessRole = "owner" | "editor" | "viewer";

export interface SavedSummary extends SummaryContent {
  id: string;
  noteId: string;
  sourceRevision: number;
  suggestedTags: string[];
  modelId: string;
  promptVersion: string;
  durationMs: number;
  generationStatus: "ready";
  isUserEdited: boolean;
  baseSummaryId?: string;
  createdAt: Date;
}

export interface ShareRecord {
  noteId: string;
  participantUid: string;
  email: string;
  role: "viewer" | "editor";
  status: "accepted" | "revoked";
  createdBy: string;
  createdAt: Date;
  acceptedAt: Date | null;
}

export interface NoteRepository {
  beginGeneration(
    noteId: string,
    requestId: string,
    uid: string,
  ): Promise<void>;
  finishGeneration(
    noteId: string,
    requestId: string,
    status: "ready" | "failed" | "cancelled",
    summaryId?: string,
  ): Promise<void>;
  cancelGeneration(
    noteId: string,
    requestId: string,
    uid: string,
  ): Promise<boolean>;
  watchGeneration(
    noteId: string,
    requestId: string,
    onCancel: () => void,
  ): () => void;
  editSummary(
    noteId: string,
    summaryId: string,
    uid: string,
    state?: string,
  ): Promise<{ state: string; valid: boolean }>;
  getNote(noteId: string): Promise<NoteDocument | undefined>;
  getRole(noteId: string, uid: string): Promise<AccessRole | null>;
  getSummary(
    noteId: string,
    summaryId: string,
  ): Promise<SavedSummary | undefined>;
  saveSummary(
    noteId: string,
    sourceRevision: number,
    content: SummaryContent,
    metadata: SummarySaveMetadata,
  ): Promise<SavedSummary>;
  listSummaries(noteId: string, limit: number): Promise<SavedSummary[]>;
  saveFeedback(
    noteId: string,
    summaryId: string,
    uid: string,
    feedback: { rating: number; comment: string; accepted: boolean },
  ): Promise<void>;
  findUserByEmail(
    email: string,
  ): Promise<{ uid: string; email: string } | undefined>;
  upsertShare(
    noteId: string,
    participantUid: string,
    share: Omit<ShareRecord, "createdAt" | "acceptedAt">,
  ): Promise<void>;
  deleteShare(noteId: string, participantUid: string): Promise<void>;
  listShares(noteId: string): Promise<ShareRecord[]>;
  deleteNoteCascade(noteId: string): Promise<void>;
}

export interface SummarySaveMetadata {
  /** Always supplied by the API from the verified Firebase ID token. */
  actorUid: string;
  isUserEdited?: boolean;
  generationRequestId?: string;
  modelId: string;
  promptVersion: string;
  durationMs: number;
  baseSummaryId?: string;
}

export interface SummarizationContext {
  requestId: string;
  modelId?: string;
  signal?: AbortSignal;
  /** Server-only admission/accounting hook for each provider call, including chunks. */
  reserveUsage?: (
    estimatedInputTokens: number,
    maxOutputTokens: number,
  ) => Promise<{ settle: (usage: TokenUsage | null) => Promise<void> }>;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
}

export interface SummarizationPort {
  summarize(
    text: string,
    options: SummaryOptions,
    context: SummarizationContext,
  ): Promise<SummaryContent>;
}

export type TokenVerifier = (token: string) => Promise<{ uid: string }>;

export type SummarizationErrorCode =
  | "AI_AUTH_FAILED"
  | "AI_MODEL_NOT_FOUND"
  | "AI_RATE_LIMITED"
  | "AI_REQUEST_REJECTED"
  | "AI_TIMEOUT"
  | "AI_INVALID_RESPONSE"
  | "AI_UNAVAILABLE";

export class SummarizationError extends Error {
  constructor(
    public readonly code: SummarizationErrorCode,
    public readonly upstreamStatus?: number,
    public readonly providerReason?: string,
  ) {
    super(code);
    this.name = "SummarizationError";
  }
}

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}
