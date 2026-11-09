import { describe, expect, test } from "vitest";
import { ENGINE_CONFIG, RETRIEVAL_CONFIG, WALLET_CONFIG } from "@/db/seed";
import { loadEngineConfig } from "../config/load";
import { CostLedger, costMicros } from "./cost";
import type { ConfigPort } from "../ports/config";

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

describe("prices of the models a turn can be served by", () => {
  const port = (rows: Record<string, unknown>): Pick<{ config: ConfigPort }, "config"> => ({
    config: { rows: async () => Object.entries(rows).map(([key, value]) => ({ key, value, creatorId: null })) } as unknown as ConfigPort,
  });
  const all = { ...WALLET_CONFIG, ...RETRIEVAL_CONFIG, ...ENGINE_CONFIG };

  test("the fallback generator's rows are loaded beside the primary's", async () => {
    const cfg = await loadEngineConfig(port(all), "c1");
    expect(Object.keys(cfg.prices).sort()).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5", "jev-1.14.0"]);
    expect(cfg.prices["claude-sonnet-5-5"]).toEqual({ input: 2000000, output: 10000000, cacheRead: 200000, cacheWrite: 2500000 });
  });

  test("a fallback with no price rows is left out, so serving from it fails closed", async () => {
    const rows = { ...all, "model.generate_fallback": "claude-unpriced" };
    const cfg = await loadEngineConfig(port(rows), "c1");
    expect(cfg.prices["claude-unpriced"]).toBeUndefined();
  });
});
