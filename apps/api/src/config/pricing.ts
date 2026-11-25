export interface ModelPricing {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  cachedInputUsdPerMillionTokens: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedInputTokens?: number;
}

// Standard text-generation prices verified on 2026-10-28:
// https://ai.google.dev/gemini-api/docs/pricing
// This is a local cost estimate, not the provider's billing statement.
export function getModelPricing(
  modelId: string,
  now = Date.now(),
): ModelPricing {
  switch (modelId) {
    case "notach-mock-v1":
      return {
        inputUsdPerMillionTokens: 0,
        outputUsdPerMillionTokens: 0,
        cachedInputUsdPerMillionTokens: 0,
      };
    case "gemini-3.5-flash-lite":
      return {
        inputUsdPerMillionTokens: 0.3,
        outputUsdPerMillionTokens: 2.5,
        cachedInputUsdPerMillionTokens: 0.03,
      };
    case "gemini-3.1-flash-lite":
      return {
        inputUsdPerMillionTokens: 0.25,
        outputUsdPerMillionTokens: 1.5,
        cachedInputUsdPerMillionTokens: 0.025,
      };
    case "gemini-3.6-flash":
    case "gemini-3.8-flash": {
      const multiplier = now >= Date.UTC(2027, 0, 1) ? 2 : 1;
      return {
        inputUsdPerMillionTokens: 0.75 * multiplier,
        outputUsdPerMillionTokens: 3.75 * multiplier,
        cachedInputUsdPerMillionTokens: 0.075 * multiplier,
      };
    }
    default:
      throw new Error("AI_MODEL_PRICING_UNAVAILABLE");
  }
}

function tokenCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("INVALID_TOKEN_USAGE");
  }
  return value;
}

// Integer nanodollars avoid rounding tiny requests down to zero cents.
export function costNanoUsd(pricing: ModelPricing, usage: TokenUsage): number {
  const input = tokenCount(usage.inputTokens);
  const cached = tokenCount(usage.cachedInputTokens ?? 0);
  const output = tokenCount(usage.outputTokens);
  const thinking = tokenCount(usage.thinkingTokens);
  if (cached > input) throw new Error("INVALID_TOKEN_USAGE");
  const rates = [
    pricing.inputUsdPerMillionTokens,
    pricing.outputUsdPerMillionTokens,
    pricing.cachedInputUsdPerMillionTokens,
  ];
  if (rates.some((rate) => !Number.isFinite(rate) || rate < 0)) {
    throw new Error("INVALID_MODEL_PRICING");
  }
  const cost = Math.ceil(
    (input - cached) * pricing.inputUsdPerMillionTokens * 1000 +
      cached * pricing.cachedInputUsdPerMillionTokens * 1000 +
      (output + thinking) * pricing.outputUsdPerMillionTokens * 1000,
  );
  if (!Number.isSafeInteger(cost)) throw new Error("INVALID_USAGE_COST");
  return cost;
}
