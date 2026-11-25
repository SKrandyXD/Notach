import { auth } from "../firebase.js";
import { runtimeConfig } from "../config/runtime.js";
import {
  LocalizedError,
  storedLanguage,
  translate,
  type Translate,
} from "../i18n/core.js";
import type { TranslationKey } from "../i18n/catalogs.js";

const apiBase = runtimeConfig.apiBaseUrl;
const READ_TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message = code,
  ) {
    super(message);
  }
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const user = auth.currentUser;
  if (!user) throw new ApiError(401, "UNAUTHENTICATED");
  // Lightweight reads must recover if the API or proxy stops responding.
  // Generation and other writes retain their existing server-side deadlines.
  const deadline = new AbortController();
  const read = (options.method ?? "GET").toUpperCase() === "GET";
  const timer = read
    ? setTimeout(() => deadline.abort(), READ_TIMEOUT_MS)
    : null;
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  async function send(token: string): Promise<Response> {
    try {
      return await fetch(`${apiBase}${path}`, {
        ...options,
        signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...(options.headers ?? {}),
        },
      });
    } catch (reason) {
      if (signal.aborted) throw reason;
      throw new ApiError(503, "API_UNAVAILABLE");
    }
  }
  try {
    let response = await send(await user.getIdToken());
    if (response.status === 401)
      response = await send(await user.getIdToken(true));
    let result: {
      ok: boolean;
      data?: T;
      error?: { code: string; message: string };
    };
    try {
      result = (await response.json()) as typeof result;
    } catch {
      throw new ApiError(502, "API_INVALID_RESPONSE");
    }
    if (!response.ok || !result.ok || result.data === undefined) {
      throw new ApiError(response.status, result.error?.code ?? "API_ERROR");
    }
    return result.data;
  } catch (reason) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (deadline.signal.aborted) throw new ApiError(504, "API_TIMEOUT");
    throw reason;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

const errorKeys: Record<string, TranslationKey> = {
  "auth/email-already-in-use": "errors.emailInUse",
  "auth/invalid-credential": "errors.invalidCredential",
  "auth/invalid-email": "errors.invalidEmail",
  "auth/weak-password": "auth.passwordShort",
  "auth/user-not-found": "errors.userNotFound",
  "auth/too-many-requests": "errors.tooManyAttempts",
  "auth/network-request-failed": "errors.firebaseUnavailable",
  "auth/user-token-expired": "errors.unauthenticated",
  "auth/invalid-user-token": "errors.unauthenticated",
  "permission-denied": "errors.permission",
  unavailable: "errors.firebaseUnavailable",
  UNAUTHENTICATED: "errors.unauthenticated",
  FORBIDDEN: "errors.permission",
  API_UNAVAILABLE: "errors.apiUnavailable",
  API_TIMEOUT: "errors.apiTimeout",
  API_INVALID_RESPONSE: "errors.apiUnavailable",
  API_NOT_DEPLOYED: "errors.apiUnavailable",
  VALIDATION_ERROR: "errors.validation",
  INVALID_JSON: "errors.validation",
  INVALID_ROUTE_PARAMETER: "errors.validation",
  NOTE_NOT_FOUND: "errors.noteNotFound",
  NOT_FOUND: "errors.noteNotFound",
  NOTE_REVISION_CONFLICT: "errors.revisionConflict",
  EMPTY_NOTE: "errors.emptyNote",
  NOTE_TOO_LARGE: "errors.noteTooLarge",
  RATE_LIMITED: "errors.rateLimited",
  DUPLICATE_REQUEST: "errors.duplicateRequest",
  AI_AUTH_FAILED: "errors.aiAuthFailed",
  AI_MODEL_NOT_FOUND: "errors.aiModelNotFound",
  AI_RATE_LIMITED: "errors.aiRateLimited",
  AI_BUDGET_EXCEEDED: "errors.aiBudgetExceeded",
  AI_REQUEST_REJECTED: "errors.aiRequestRejected",
  AI_TIMEOUT: "errors.aiTimeout",
  AI_INVALID_RESPONSE: "errors.aiInvalidResponse",
  AI_UNAVAILABLE: "errors.aiUnavailable",
  AI_CANCELLED: "summary.cancelled",
  GENERATION_IN_PROGRESS: "summary.alreadyGenerating",
  SUMMARY_NOT_FOUND: "errors.summaryNotFound",
  USER_NOT_FOUND: "errors.userNotFound",
  INVALID_SHARE: "errors.invalidShare",
  INVALID_MODEL: "errors.invalidModel",
  COLLABORATION_READ_ONLY: "errors.permission",
  COLLABORATION_NOT_READY: "errors.collaborationNotReady",
  COLLABORATION_DESTROYED: "errors.collaborationNotReady",
  COLLABORATION_INVALID_STATE: "errors.collaborationState",
  COLLABORATION_STATE_TOO_LARGE: "errors.collaborationState",
  COLLABORATION_CONTENT_TOO_LARGE: "errors.noteTooLarge",
};

export function friendlyError(
  error: unknown,
  t: Translate = (key, params) => translate(storedLanguage(), key, params),
): string {
  if (error instanceof LocalizedError) return t(error.translationKey);
  const code = (error as { code?: string } | null)?.code;
  if (code && errorKeys[code]) return t(errorKeys[code]);
  if ((error as { name?: string } | null)?.name === "ZodError")
    return t("errors.validation");
  return t("errors.unknown");
}
