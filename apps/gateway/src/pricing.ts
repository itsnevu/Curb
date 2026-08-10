import { readFileSync } from "node:fs";

export interface ModelPrice {
  /** USD per input token */
  in: number;
  /** USD per output token */
  out: number;
}

/**
 * Price per ONE MILLION tokens (USD) — easier to read and to override.
 * Source: the public OpenAI and Anthropic pricing pages. Override without a deploy
 * via CURB_PRICING_FILE (a JSON file) or CURB_PRICING (inline JSON).
 */
export const DEFAULT_PRICING_PER_MTOK: Record<string, ModelPrice> = {
  // OpenAI
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4.1": { in: 2, out: 8 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "gpt-4.1-nano": { in: 0.1, out: 0.4 },
  "o3": { in: 2, out: 8 },
  "o4-mini": { in: 1.1, out: 4.4 },
  // Anthropic
  "claude-opus-4": { in: 15, out: 75 },
  "claude-sonnet-4": { in: 3, out: 15 },
  "claude-3-5-haiku": { in: 0.8, out: 4 },
  "claude-3-haiku": { in: 0.25, out: 1.25 },
  // Fallback for unknown models — deliberately expensive. Fail-safe: over-estimating
  // and tripping the breaker early beats letting a cost cap leak.
  default: { in: 5, out: 15 },
};

export class PriceTable {
  private table: Record<string, ModelPrice>;

  constructor(perMTok: Record<string, ModelPrice> = loadPricingFromEnv()) {
    this.table = Object.fromEntries(
      Object.entries(perMTok).map(([k, v]) => [k, { in: v.in / 1e6, out: v.out / 1e6 }]),
    );
  }

  /** Match the model exactly, then by longest prefix (e.g. "gpt-4o-2024-08-06" → "gpt-4o"). */
  priceFor(model: string | undefined): ModelPrice {
    if (!model) return this.table.default;
    if (this.table[model]) return this.table[model];
    const prefixes = Object.keys(this.table)
      .filter((k) => k !== "default" && model.startsWith(k))
      .sort((a, b) => b.length - a.length);
    return prefixes.length > 0 ? this.table[prefixes[0]] : this.table.default;
  }

  costUsd(model: string | undefined, usage: { promptTokens: number; completionTokens: number }): number {
    const p = this.priceFor(model);
    return usage.promptTokens * p.in + usage.completionTokens * p.out;
  }

  has(model: string): boolean {
    return this.priceFor(model) !== this.table.default;
  }
}

function loadPricingFromEnv(): Record<string, ModelPrice> {
  const override = readOverride();
  return override ? { ...DEFAULT_PRICING_PER_MTOK, ...override } : DEFAULT_PRICING_PER_MTOK;
}

function readOverride(): Record<string, ModelPrice> | null {
  try {
    if (process.env.CURB_PRICING) return JSON.parse(process.env.CURB_PRICING);
    if (process.env.CURB_PRICING_FILE) {
      return JSON.parse(readFileSync(process.env.CURB_PRICING_FILE, "utf8"));
    }
  } catch {
    // why: broken pricing config must not take the gateway down — fall back to the
    // defaults, which are deliberately expensive and therefore still fail-safe.
  }
  return null;
}
