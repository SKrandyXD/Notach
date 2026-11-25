import { describe, expect, it, vi } from "vitest";

const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
  ThinkingLevel: { LOW: "LOW" },
}));

import { GeminiAdapter } from "./gemini-adapter.js";

const options = {
  language: "uk",
  length: "short",
  generateTags: true,
} as const;
const context = { requestId: "test-request" };

describe("Gemini adapter", () => {
  it("fails closed when production usage accounting is unavailable", async () => {
    const before = generateContent.mock.calls.length;
    await expect(
      new GeminiAdapter("test-key", "gemini-3.5-flash-lite", {
        requireUsageAccounting: true,
      }).summarize("Source", options, context),
    ).rejects.toMatchObject({ code: "AI_UNAVAILABLE" });
    expect(generateContent.mock.calls.length).toBe(before);
  });

  it("retains the reserve for incomplete or inconsistent provider statistics", async () => {
    const settle = vi.fn(async () => undefined);
    for (const usageMetadata of [
      { promptTokenCount: 100, totalTokenCount: 1000 },
      {
        promptTokenCount: 100,
        candidatesTokenCount: 10,
        totalTokenCount: 1000,
      },
    ]) {
      generateContent.mockResolvedValueOnce({
        text: JSON.stringify({
          shortText: "Summary",
          keyPoints: ["Fact"],
          tags: [],
        }),
        usageMetadata,
      });
      await new GeminiAdapter("test-key", "gemini-3.5-flash-lite").summarize(
        "Source",
        options,
        { ...context, reserveUsage: async () => ({ settle }) },
      );
      expect(settle).toHaveBeenLastCalledWith(null);
    }
  });

  it("reserves before generation and accounts for input, cache, output and thinking", async () => {
    const settle = vi.fn(async () => undefined);
    const reserveUsage = vi.fn(async () => ({ settle }));
    generateContent.mockResolvedValueOnce({
      text: JSON.stringify({
        shortText: "Summary",
        keyPoints: ["Fact"],
        tags: [],
      }),
      usageMetadata: {
        promptTokenCount: 100,
        cachedContentTokenCount: 20,
        candidatesTokenCount: 30,
        thoughtsTokenCount: 40,
      },
    });
    await new GeminiAdapter("test-key", "gemini-3.5-flash-lite").summarize(
      "Source",
      options,
      { ...context, reserveUsage },
    );
    expect(reserveUsage).toHaveBeenCalledWith(expect.any(Number), 8192);
    expect(settle).toHaveBeenCalledWith({
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 30,
      thinkingTokens: 40,
    });
    expect(generateContent.mock.calls.at(-1)![0].config.maxOutputTokens).toBe(
      8192,
    );
  });

  it("never calls Gemini if the budget reservation is denied", async () => {
    const before = generateContent.mock.calls.length;
    await expect(
      new GeminiAdapter("test-key", "gemini-3.5-flash-lite").summarize(
        "Source",
        options,
        {
          ...context,
          reserveUsage: async () => {
            throw new Error("AI_BUDGET_EXCEEDED");
          },
        },
      ),
    ).rejects.toThrow("AI_BUDGET_EXCEEDED");
    expect(generateContent.mock.calls.length).toBe(before);
  });

  it("accounts for malformed JSON and charges uncertain work conservatively", async () => {
    const settle = vi.fn(async () => undefined);
    const reserveUsage = async () => ({ settle });
    generateContent.mockResolvedValueOnce({
      text: "invalid JSON",
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
    });
    await expect(
      new GeminiAdapter("test-key", "gemini-3.5-flash-lite").summarize(
        "Source",
        options,
        { ...context, reserveUsage },
      ),
    ).rejects.toMatchObject({ code: "AI_INVALID_RESPONSE" });
    expect(settle).toHaveBeenLastCalledWith({
      inputTokens: 10,
      outputTokens: 3,
      thinkingTokens: 0,
      cachedInputTokens: 0,
    });
    generateContent.mockRejectedValueOnce(new Error("connection lost"));
    await expect(
      new GeminiAdapter("test-key", "gemini-3.5-flash-lite").summarize(
        "Source",
        options,
        { ...context, reserveUsage },
      ),
    ).rejects.toThrow();
    expect(settle).toHaveBeenLastCalledWith(null);
  });

  it("releases reservations for explicit provider rejection before generation", async () => {
    const settle = vi.fn(async () => undefined);
    generateContent.mockRejectedValueOnce({ status: 429 });
    await expect(
      new GeminiAdapter("test-key", "gemini-3.5-flash-lite").summarize(
        "Source",
        options,
        { ...context, reserveUsage: async () => ({ settle }) },
      ),
    ).rejects.toMatchObject({ code: "AI_RATE_LIMITED" });
    expect(settle).toHaveBeenCalledWith({
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      cachedInputTokens: 0,
    });
  });

  it("requires a title in structured output only when the option is enabled", async () => {
    generateContent.mockResolvedValueOnce({
      text: JSON.stringify({
        shortText: "Summary",
        keyPoints: ["Fact"],
        tags: [],
        suggestedTitle: "A factual title",
      }),
    });
    const result = await new GeminiAdapter(
      "test-key",
      "gemini-3.5-flash-lite",
    ).summarize("A source note.", { ...options, generateTitle: true }, context);
    expect(result.suggestedTitle).toBe("A factual title");
    expect(
      generateContent.mock.calls.at(-1)![0].config.responseJsonSchema.required,
    ).toContain("suggestedTitle");
    generateContent.mockResolvedValueOnce({
      text: JSON.stringify({
        shortText: "Summary",
        keyPoints: ["Fact"],
        tags: [],
        suggestedTitle: "Unrequested title",
      }),
    });
    expect(
      await new GeminiAdapter("test-key", "gemini-3.5-flash-lite").summarize(
        "A source note.",
        options,
        context,
      ),
    ).not.toHaveProperty("suggestedTitle");
  });

  it("rejects an absent title when title generation was explicitly requested", async () => {
    generateContent.mockResolvedValueOnce({
      text: JSON.stringify({
        shortText: "Summary",
        keyPoints: ["Fact"],
        tags: [],
      }),
    });
    await expect(
      new GeminiAdapter("test-key", "gemini-3.5-flash-lite").summarize(
        "A source note.",
        { ...options, generateTitle: true },
        context,
      ),
    ).rejects.toMatchObject({ code: "AI_INVALID_RESPONSE" });
  });
  it("uses the requested model for every chunk and the combined result", async () => {
    generateContent.mockReset();
    generateContent.mockResolvedValue({
      text: JSON.stringify({
        shortText: "Summary",
        keyPoints: ["Fact"],
        tags: ["topic"],
      }),
    });
    await new GeminiAdapter("test-key", "gemini-3.5-flash-lite").summarize(
      "word ".repeat(2000),
      options,
      { ...context, modelId: "gemini-3.6-flash" },
    );

    expect(generateContent).toHaveBeenCalledTimes(3);
    expect(
      generateContent.mock.calls.every(
        ([call]) => call.model === "gemini-3.6-flash",
      ),
    ).toBe(true);
    generateContent.mockReset();
  });

  it("uses structured output without sampling parameters rejected by Gemini 3.8", async () => {
    generateContent.mockResolvedValueOnce({
      text: JSON.stringify({
        shortText: "Summary",
        keyPoints: ["Fact"],
        tags: ["topic"],
      }),
    });
    const result = await new GeminiAdapter(
      "test-key",
      "gemini-3.8-flash",
    ).summarize("A source note.", options, context);
    expect(result.shortText).toBe("Summary");
    const request = generateContent.mock.calls.at(-1)![0];
    expect(request.config).toMatchObject({
      responseMimeType: "application/json",
      responseJsonSchema: expect.any(Object),
      thinkingConfig: { thinkingLevel: "LOW" },
    });
    expect(request.config).not.toHaveProperty("temperature");
    expect(request.config).not.toHaveProperty("topP");
  });

  it("rejects schema-invalid JSON as a provider response error", async () => {
    generateContent.mockResolvedValueOnce({
      text: JSON.stringify({ shortText: "Summary", keyPoints: [], tags: [] }),
    });
    await expect(
      new GeminiAdapter("test-key", "gemini-3.8-flash").summarize(
        "A source note.",
        options,
        context,
      ),
    ).rejects.toMatchObject({ code: "AI_INVALID_RESPONSE" });
  });

  it("preserves an upstream quota failure", async () => {
    generateContent.mockRejectedValueOnce({
      status: 429,
      message: "Quota exceeded",
    });
    await expect(
      new GeminiAdapter("test-key", "gemini-3.8-flash").summarize(
        "A source note.",
        options,
        context,
      ),
    ).rejects.toMatchObject({ code: "AI_RATE_LIMITED", upstreamStatus: 429 });
  });
});
