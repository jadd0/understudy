/** Price rows are whole micro-dollars per million tokens, so one token costs `price / 1e6` micro-dollars. */
export interface Prices {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Cost of one call in whole micro-dollars (rounded once, at the end). */
export function costMicros(prices: Prices, u: TokenUsage): number {
  const total =
    u.inputTokens * prices.input +
    u.outputTokens * prices.output +
    (u.cacheReadTokens ?? 0) * prices.cacheRead +
    (u.cacheWriteTokens ?? 0) * prices.cacheWrite;
  return Math.round(total / 1_000_000);
}

/** Collects the calls of one turn: tokens by stage, and a total that sums each call's rounded cost (under one micro-dollar of drift per call). */
export class CostLedger {
  readonly tokens: Record<string, TokenUsage> = {};
  private micros = 0;

  add(stage: string, prices: Prices, usage: TokenUsage) {
    const prev = this.tokens[stage];
    this.tokens[stage] = prev
      ? {
          inputTokens: prev.inputTokens + usage.inputTokens,
          outputTokens: prev.outputTokens + usage.outputTokens,
          cacheReadTokens: (prev.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
          cacheWriteTokens: (prev.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
        }
      : { ...usage };
    this.micros += costMicros(prices, usage);
  }

  get costMicros() {
    return this.micros;
  }
}
