import { afterEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({
  currentUser: null as null | {
    getIdToken: (forceRefresh?: boolean) => Promise<string>;
  },
}));

vi.mock("../firebase.js", () => ({ auth: authState }));

import { ApiError, apiRequest, friendlyError } from "./api.js";
import { translate } from "../i18n/core.js";

afterEach(() => {
  authState.currentUser = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("API error messages", () => {
  it("bounds a stalled model request and reports an actionable timeout", async () => {
    vi.useFakeTimers();
    authState.currentUser = { getIdToken: async () => "test-token" };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, options: RequestInit) =>
          new Promise((_resolve, reject) =>
            options.signal!.addEventListener(
              "abort",
              () => reject(options.signal!.reason),
              { once: true },
            ),
          ),
      ),
    );
    const pending = apiRequest("/api/models");
    const assertion = expect(pending).rejects.toMatchObject({
      status: 504,
      code: "API_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it("preserves explicit caller cancellation instead of reporting server failure", async () => {
    authState.currentUser = { getIdToken: async () => "test-token" };
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, options: RequestInit) =>
          new Promise((_resolve, reject) =>
            options.signal!.addEventListener(
              "abort",
              () => reject(options.signal!.reason),
              { once: true },
            ),
          ),
      ),
    );
    const pending = apiRequest("/api/models", { signal: controller.signal });
    const reason = new DOMException("Navigation changed", "AbortError");
    const assertion = expect(pending).rejects.toBe(reason);
    await Promise.resolve();
    controller.abort(reason);
    await assertion;
  });

  it("does not apply the short metadata deadline to a generation POST", async () => {
    vi.useFakeTimers();
    authState.currentUser = { getIdToken: async () => "test-token" };
    let finish!: (value: Response) => void;
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, options: RequestInit) => {
        signal = options.signal;
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }),
    );
    const pending = apiRequest("/api/summarize", {
      method: "POST",
      body: "{}",
    });
    await vi.advanceTimersByTimeAsync(15_001);
    expect(signal?.aborted).toBe(false);
    finish({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        data: { saved: true },
      }),
    } as Response);
    await expect(pending).resolves.toEqual({ saved: true });
  });

  it("localizes backend error codes using the selected UI language", () => {
    const error = new ApiError(
      409,
      "NOTE_REVISION_CONFLICT",
      "Provider text must not be displayed.",
    );
    expect(
      friendlyError(error, (key, params) => translate("en", key, params)),
    ).toBe(translate("en", "errors.revisionConflict"));
    expect(
      friendlyError(new ApiError(403, "AI_AUTH_FAILED"), (key, params) =>
        translate("uk", key, params),
      ),
    ).toBe(translate("uk", "errors.aiAuthFailed"));
  });

  it("translates Firebase permission errors", () => {
    expect(friendlyError({ code: "permission-denied" })).toBe(
      "У вас немає доступу до цієї нотатки.",
    );
  });

  it("refreshes the Firebase ID token once when the API rejects a stale token", async () => {
    const getIdToken = vi.fn(async (forceRefresh?: boolean) =>
      forceRefresh ? "fresh-token" : "cached-token",
    );
    authState.currentUser = { getIdToken };
    const response = (status: number, body: unknown) =>
      ({
        status,
        ok: status >= 200 && status < 300,
        json: async () => body,
      }) as Response;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(401, {
          ok: false,
          error: { code: "UNAUTHENTICATED", message: "expired" },
        }),
      )
      .mockResolvedValueOnce(
        response(200, { ok: true, data: { saved: true } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      apiRequest<{ saved: boolean }>("/api/test", {
        method: "POST",
        body: "{}",
      }),
    ).resolves.toEqual({ saved: true });

    expect(getIdToken).toHaveBeenNthCalledWith(1);
    expect(getIdToken).toHaveBeenNthCalledWith(2, true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1]![1] as RequestInit).headers).toMatchObject({
      Authorization: "Bearer fresh-token",
    });
  });
});
