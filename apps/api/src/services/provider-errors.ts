import { SummarizationError } from "../domain.js";

const safeReasons = new Set([
  "INVALID_ARGUMENT",
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
  "NOT_FOUND",
  "RESOURCE_EXHAUSTED",
  "UNAVAILABLE",
  "DEADLINE_EXCEEDED",
  "INTERNAL",
  "API_KEY_INVALID",
  "API_KEY_EXPIRED",
  "API_KEY_SERVICE_BLOCKED",
  "API_KEY_HTTP_REFERRER_BLOCKED",
  "API_KEY_IP_ADDRESS_BLOCKED",
  "SERVICE_DISABLED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/** Keep only allowlisted metadata: provider messages can contain request details. */
export function normalizeProviderError(error: unknown): SummarizationError {
  if (error instanceof SummarizationError) return error;
  const source = record(error);
  let payload: Record<string, unknown> = {};
  if (typeof source.message === "string") {
    try {
      payload = record(record(JSON.parse(source.message)).error);
    } catch {
      /* Non-JSON SDK/network errors. */
    }
  }
  const statusValue = source.status ?? payload.code;
  const status =
    typeof statusValue === "number" && Number.isInteger(statusValue)
      ? statusValue
      : undefined;
  const details = Array.isArray(payload.details)
    ? payload.details.map(record)
    : [];
  const candidates = [
    ...details.map((detail) => detail.reason),
    payload.status,
    source.code,
    record(source.cause).code,
  ];
  const reason = candidates.find(
    (value): value is string =>
      typeof value === "string" && safeReasons.has(value),
  );
  const name = typeof source.name === "string" ? source.name : "";
  if (
    [
      "AbortError",
      "TimeoutError",
      "RequestTimeoutError",
      "RequestAbortedError",
    ].includes(name) ||
    status === 408 ||
    status === 504 ||
    reason === "DEADLINE_EXCEEDED" ||
    reason === "ETIMEDOUT" ||
    reason === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return new SummarizationError("AI_TIMEOUT", status, reason);
  }
  if (
    status === 401 ||
    status === 403 ||
    reason?.startsWith("API_KEY_") ||
    reason === "SERVICE_DISABLED"
  )
    return new SummarizationError("AI_AUTH_FAILED", status, reason);
  if (status === 404)
    return new SummarizationError("AI_MODEL_NOT_FOUND", status, reason);
  if (status === 429)
    return new SummarizationError("AI_RATE_LIMITED", status, reason);
  if (status === 400 || status === 422)
    return new SummarizationError("AI_REQUEST_REJECTED", status, reason);
  return new SummarizationError("AI_UNAVAILABLE", status, reason);
}
