import { beforeAll, describe, expect, test } from "vitest";
import { buildWorld } from "./fixtures";
import { getCost } from "./cost";

let w: Awaited<ReturnType<typeof buildWorld>>;
beforeAll(async () => {
  w = await buildWorld();
});

describe("getCost", () => {
  test("cost_per_reply_excludes_superseded", async () => {
    const c = await getCost(w.q);
    // 1000 + 2000 + 500 (superseded) + 100 + 0 + 1500 + 0 over 4 replied turns; the superseded one is spend, not a reply.
    expect(c.totalMicros).toBe(5100);
    expect(c.replies).toBe(4);
    expect(c.perReplyMicros).toBe(1275);
    expect(c.series.reduce((s, p) => s + p.micros, 0)).toBe(5100);
  });

  test("by_model_reprices_tokens_at_config_prices", async () => {
    const c = await getCost(w.q);
    const gen = c.byModel.find((m) => m.stage === "generate")!;
    // generate ran on t1, t2, t3, t7, t10 (5 turns): 2000 in, 100 out, 500 cache read each.
    expect(gen).toMatchObject({ model: "claude-haiku-5-5", inputTokens: 10000, outputTokens: 500, cacheReadTokens: 2500 });
    // (10000*100000 + 500*500000 + 2500*10000) / 1e6
    expect(gen.estimatedMicros).toBe(1275);
    expect(c.byModel.find((m) => m.stage === "jev_in")?.model).toBe("jev-1.14.0");
  });
});
