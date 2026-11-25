import { describe, expect, it } from "vitest";
import { costNanoUsd, getModelPricing } from "./pricing.js";

const october2026 = Date.UTC(2026, 9, 28);

describe("model token pricing", () => {
  it("charges separate input, output, and thinking tokens", () => {
    expect(
      costNanoUsd(getModelPricing("gemini-3.5-flash-lite", october2026), {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        thinkingTokens: 100_000,
      }),
    ).toBe(800_000_000);
  });

  it("applies cached-input pricing without double counting", () => {
    expect(
      costNanoUsd(getModelPricing("gemini-3.1-flash-lite", october2026), {
        inputTokens: 1_000_000,
        cachedInputTokens: 400_000,
        outputTokens: 100_000,
        thinkingTokens: 0,
      }),
    ).toBe(310_000_000);
  });

  it("keeps sub-cent requests instead of rounding them to zero", () => {
    expect(
      costNanoUsd(getModelPricing("gemini-3.5-flash-lite", october2026), {
        inputTokens: 1,
        outputTokens: 1,
        thinkingTokens: 0,
      }),
    ).toBe(2800);
  });

  it.each(["gemini-3.6-flash", "gemini-3.8-flash"])(
    "changes the scheduled %s tariff at the UTC boundary",
    (modelId) => {
      const last2026 = Date.UTC(2027, 0, 1) - 1;
      expect(getModelPricing(modelId, last2026)).toEqual({
        inputUsdPerMillionTokens: 0.75,
        outputUsdPerMillionTokens: 3.75,
        cachedInputUsdPerMillionTokens: 0.075,
      });
      expect(getModelPricing(modelId, last2026 + 1)).toEqual({
        inputUsdPerMillionTokens: 1.5,
        outputUsdPerMillionTokens: 7.5,
        cachedInputUsdPerMillionTokens: 0.15,
      });
    },
  );

  it("never assigns a guessed price to an unknown model", () => {
    expect(() => getModelPricing("gemini-unlisted")).toThrow(
      "AI_MODEL_PRICING_UNAVAILABLE",
    );
  });

  it("charges nothing for the deterministic mock", () => {
    expect(
      costNanoUsd(getModelPricing("notach-mock-v1"), {
        inputTokens: 1000,
        outputTokens: 1000,
        thinkingTokens: 0,
      }),
    ).toBe(0);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid token count %s",
    (inputTokens) => {
      expect(() =>
        costNanoUsd(getModelPricing("gemini-3.5-flash-lite"), {
          inputTokens,
          outputTokens: 0,
          thinkingTokens: 0,
        }),
      ).toThrow("INVALID_TOKEN_USAGE");
    },
  );

  it("rejects more cached tokens than total input", () => {
    expect(() =>
      costNanoUsd(getModelPricing("gemini-3.5-flash-lite"), {
        inputTokens: 1,
        cachedInputTokens: 2,
        outputTokens: 0,
        thinkingTokens: 0,
      }),
    ).toThrow("INVALID_TOKEN_USAGE");
  });
});
