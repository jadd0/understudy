import { describe, expect, test } from "vitest";
import { CostLedger, costMicros } from "./cost";

const HAIKU = { input: 100000, output: 500000, cacheRead: 10000, cacheWrite: 125000 };
const JEV = { input: 42000, output: 0, cacheRead: 0, cacheWrite: 0 };

describe("costMicros", () => {
  test("tokens times the per-Mtok rate, in whole micro-dollars", () => {
    // 1M input tokens at $0.10 per Mtok = $0.10 = 100,000 micro-dollars
    expect(costMicros(HAIKU, { inputTokens: 1_000_000, outputTokens: 0 })).toBe(100000);
    expect(costMicros(HAIKU, { inputTokens: 2000, outputTokens: 100, cacheReadTokens: 7000, cacheWriteTokens: 1000 })).toBe(
      Math.round((2000 * 100000 + 100 * 500000 + 7000 * 10000 + 1000 * 125000) / 1e6),
    );
    expect(costMicros(JEV, { inputTokens: 500, outputTokens: 99 })).toBe(21);
  });

  test("the ledger sums rounded calls and keeps tokens by stage", () => {
    const l = new CostLedger();
    l.add("gen", HAIKU, { inputTokens: 1_000_000, outputTokens: 0 });
    l.add("gen", HAIKU, { inputTokens: 1_000_000, outputTokens: 0 });
    l.add("jev_in", JEV, { inputTokens: 1000, outputTokens: 0 });
    expect(l.costMicros).toBe(200000 + 42);
    expect(l.tokens.gen.inputTokens).toBe(2_000_000);
    expect(Object.keys(l.tokens).sort()).toEqual(["gen", "jev_in"]);
  });
});
