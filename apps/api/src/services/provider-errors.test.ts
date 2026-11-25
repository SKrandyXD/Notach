import { describe, expect, it } from "vitest";
import { normalizeProviderError } from "./provider-errors.js";

describe("Gemini failure classification", () => {
  it.each([
    [400, "AI_REQUEST_REJECTED"],
    [401, "AI_AUTH_FAILED"],
    [403, "AI_AUTH_FAILED"],
    [404, "AI_MODEL_NOT_FOUND"],
    [429, "AI_RATE_LIMITED"],
    [503, "AI_UNAVAILABLE"],
    [504, "AI_TIMEOUT"],
  ])("maps upstream HTTP %s without leaking its message", (status, code) => {
    const result = normalizeProviderError({
      status,
      message: "private-note-and-api-key",
    });
    expect(result.code).toBe(code);
    expect(result.upstreamStatus).toBe(status);
    expect(result.message).not.toContain("private");
    expect(result.providerReason).toBeUndefined();
  });

  it("recognizes an invalid API key reported as HTTP 400", () => {
    const result = normalizeProviderError({
      status: 400,
      message: JSON.stringify({
        error: {
          status: "INVALID_ARGUMENT",
          details: [{ reason: "API_KEY_INVALID" }],
        },
      }),
    });
    expect(result.code).toBe("AI_AUTH_FAILED");
    expect(result.providerReason).toBe("API_KEY_INVALID");
  });

  it("preserves a safe network code and classifies timeout names", () => {
    expect(
      normalizeProviderError({ cause: { code: "ENOTFOUND" } }).providerReason,
    ).toBe("ENOTFOUND");
    expect(normalizeProviderError({ name: "TimeoutError" }).code).toBe(
      "AI_TIMEOUT",
    );
    expect(
      normalizeProviderError({ code: "private-note" }).providerReason,
    ).toBeUndefined();
  });
});
