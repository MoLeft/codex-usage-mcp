import type { UsageDelta } from "./types.js";

export interface PricingRatesPerMillion {
  input: number;
  cachedInput: number;
  output: number;
}

const DEFAULT_PRICING: Record<string, PricingRatesPerMillion> = {
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15.0 },
  "gpt-5.4-pro": { input: 30.0, cachedInput: 30.0, output: 180.0 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cachedInput: 0.02, output: 1.25 },
  "gpt-5.4-chat-latest": { input: 2.5, cachedInput: 0.25, output: 15.0 },
  "gpt-5.2": { input: 1.75, cachedInput: 0.175, output: 14.0 },
  "gpt-5.1": { input: 1.25, cachedInput: 0.125, output: 10.0 },
  "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10.0 },
  "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2.0 },
  "gpt-5-nano": { input: 0.05, cachedInput: 0.005, output: 0.4 },
  "gpt-5-pro": { input: 15.0, cachedInput: 15.0, output: 120.0 },
  "gpt-5.2-pro": { input: 21.0, cachedInput: 21.0, output: 168.0 },
  "gpt-4.1": { input: 2.0, cachedInput: 0.5, output: 8.0 },
  "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, cachedInput: 0.025, output: 0.4 },
  "gpt-4o": { input: 2.5, cachedInput: 1.25, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6 },
  "o1": { input: 15.0, cachedInput: 7.5, output: 60.0 },
  "o1-pro": { input: 150.0, cachedInput: 150.0, output: 600.0 },
  "o1-mini": { input: 1.1, cachedInput: 0.55, output: 4.4 },
  "o3": { input: 2.0, cachedInput: 0.5, output: 8.0 },
  "o3-pro": { input: 20.0, cachedInput: 20.0, output: 80.0 },
  "o3-mini": { input: 1.1, cachedInput: 0.55, output: 4.4 },
  "o4-mini": { input: 1.1, cachedInput: 0.275, output: 4.4 },
  "codex-mini-latest": { input: 1.5, cachedInput: 0.375, output: 6.0 }
};

const MODEL_ALIASES: Record<string, string> = {
  "gpt-5.4-codex": "gpt-5.4",
  "gpt-5.4-codex-mini": "gpt-5.4-mini",
  "gpt-5.4-codex-nano": "gpt-5.4-nano",
  "gpt-5.4-codex-pro": "gpt-5.4-pro",
  "gpt-5.4-max": "gpt-5.4",
  "gpt-5.1-codex-max": "gpt-5.1",
  "gpt-5.1-codex": "gpt-5.1",
  "gpt-5.1-codex-mini": "gpt-5-mini",
  "gpt-5-codex": "gpt-5"
};

function canonicalizeModelId(model: string): string | null {
  const value = model.trim().toLowerCase();
  if (!value) return null;
  if (DEFAULT_PRICING[value]) return value;
  if (MODEL_ALIASES[value]) return MODEL_ALIASES[value];
  if (value.startsWith("gpt-5.4")) return "gpt-5.4";
  if (value.startsWith("gpt-5.2")) return "gpt-5.2";
  if (value.startsWith("gpt-5.1")) return "gpt-5.1";
  if (value.startsWith("gpt-5-mini")) return "gpt-5-mini";
  if (value.startsWith("gpt-5-nano")) return "gpt-5-nano";
  if (value.startsWith("gpt-5")) return "gpt-5";
  if (value.startsWith("gpt-4o-mini")) return "gpt-4o-mini";
  if (value.startsWith("gpt-4o")) return "gpt-4o";
  if (value.startsWith("gpt-4.1-mini")) return "gpt-4.1-mini";
  if (value.startsWith("gpt-4.1-nano")) return "gpt-4.1-nano";
  if (value.startsWith("gpt-4.1")) return "gpt-4.1";
  if (value.startsWith("o1-pro")) return "o1-pro";
  if (value.startsWith("o1-mini")) return "o1-mini";
  if (value.startsWith("o1")) return "o1";
  if (value.startsWith("o3-pro")) return "o3-pro";
  if (value.startsWith("o3-mini")) return "o3-mini";
  if (value.startsWith("o3")) return "o3";
  if (value.startsWith("o4-mini")) return "o4-mini";
  return null;
}

function ratesForModel(model: string): { rates: PricingRatesPerMillion | null; pricingSource: string } {
  const direct = DEFAULT_PRICING[model];
  if (direct) return { rates: direct, pricingSource: "direct" };

  const alias = MODEL_ALIASES[model];
  if (alias && DEFAULT_PRICING[alias]) {
    return { rates: DEFAULT_PRICING[alias], pricingSource: `alias:${alias}` };
  }

  const canonical = canonicalizeModelId(model);
  if (canonical && DEFAULT_PRICING[canonical]) {
    return { rates: DEFAULT_PRICING[canonical], pricingSource: `heuristic:${canonical}` };
  }

  return { rates: null, pricingSource: "unknown" };
}

function applyLongContextPricing(
  model: string,
  inputTokens: number,
  rates: PricingRatesPerMillion
): PricingRatesPerMillion {
  if (inputTokens <= 272_000) return rates;
  if (model.startsWith("gpt-5.4-pro")) {
    return { input: 60.0, cachedInput: 60.0, output: 180.0 };
  }
  if (model.startsWith("gpt-5.4")) {
    return { input: 5.0, cachedInput: 0.5, output: 15.0 };
  }
  return rates;
}

export function estimateCostUsd(
  model: string,
  delta: UsageDelta
): { estimatedCostUsd: number | null; pricingSource: string } {
  const resolved = ratesForModel(model);
  if (!resolved.rates) {
    return { estimatedCostUsd: null, pricingSource: resolved.pricingSource };
  }

  const inputTotal = Math.max(0, delta.inputTokens);
  const cached = Math.max(0, Math.min(inputTotal, delta.cachedInputTokens));
  const uncached = Math.max(0, inputTotal - cached);
  const output = Math.max(0, delta.outputTokens);
  const effectiveRates = applyLongContextPricing(model, inputTotal, resolved.rates);

  const estimatedCostUsd =
    uncached * (effectiveRates.input / 1_000_000) +
    cached * (effectiveRates.cachedInput / 1_000_000) +
    output * (effectiveRates.output / 1_000_000);

  return {
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)),
    pricingSource: resolved.pricingSource
  };
}
