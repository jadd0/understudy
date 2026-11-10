import { describe, expect, it } from "vitest";
import { DeciderUnavailable, type Decider, type DeciderResult, type Question } from "@jadd0/understudy-engine";
import { FailoverDecider } from "./decider.js";

const Q: Question[] = [{ key: "q", prompt: "p", options: [{ key: "a", label: "A" }] }];
const OK = (model: string): DeciderResult => ({
  answers: [{ key: "q", value: "a", confidence: 1, probabilities: { a: 1 } }],
  model,
  usage: { inputTokens: 1, outputTokens: 1 },
});

function fake(behave: () => DeciderResult | Error) {
  const f = { calls: 0, ask: async () => { f.calls++; const r = behave(); if (r instanceof Error) throw r; return r; } };
  return f as Decider & { calls: number };
}

function build(list: Array<[string, Decider]>) {
  const clock = { t: 0, now() { return this.t; } };
  const lines: string[] = [];
  const d = new FailoverDecider(
    list.map(([name, decider]) => ({ name, decider })),
    { failures: 2, windowMs: 60_000, cooldownMs: 30_000, clock },
    (l) => lines.push(l),
  );
  return { d, clock, lines };
}

describe("FailoverDecider", () => {
  it("falls through to the next decider on DeciderUnavailable", async () => {
    const a = fake(() => new DeciderUnavailable("http_503"));
    const b = fake(() => OK("b"));
    const { d, lines } = build([["jev", a], ["claude", b]]);
    const r = await d.ask(Q, { state: {} });
    expect(r.model).toBe("b");
    expect([a.calls, b.calls]).toEqual([1, 1]);
    expect(lines).toEqual(["provider: jev unavailable (http_503), using claude"]);
  });

  it("skips an open breaker without calling it", async () => {
    const a = fake(() => new DeciderUnavailable("timeout"));
    const b = fake(() => OK("b"));
    const { d, clock } = build([["jev", a], ["claude", b]]);
    await d.ask(Q, { state: {} });
    await d.ask(Q, { state: {} });
    expect(a.calls).toBe(2);
    for (let i = 0; i < 5; i++) await d.ask(Q, { state: {} });
    expect(a.calls).toBe(2);
    expect(b.calls).toBe(7);
    clock.t += 30_000;
    await d.ask(Q, { state: {} });
    expect(a.calls).toBe(3);
  });

  it("all unavailable rethrows the last DeciderUnavailable", async () => {
    const a = fake(() => new DeciderUnavailable("timeout"));
    const b = fake(() => new DeciderUnavailable("http_429"));
    const { d } = build([["jev", a], ["claude", b]]);
    await expect(d.ask(Q, { state: {} })).rejects.toMatchObject({ name: "DeciderUnavailable", reason: "http_429" });
  });

  it("a non-outage error propagates without trying the next", async () => {
    const a = fake(() => new TypeError("bug"));
    const b = fake(() => OK("b"));
    const { d } = build([["jev", a], ["claude", b]]);
    await expect(d.ask(Q, { state: {} })).rejects.toBeInstanceOf(TypeError);
    expect(b.calls).toBe(0);
  });

  it.each(["not_configured", "gateway_budget", "gateway_rate_limited"])("%s_skips_without_opening_the_breaker", async (code) => {
    const a = fake(() => new DeciderUnavailable(code));
    const b = fake(() => OK("b"));
    const { d, lines } = build([["gateway", a], ["claude", b]]);
    // The breaker opens at 2 failures: five calls that each skip the entry still reach it every time.
    for (let i = 0; i < 5; i++) expect((await d.ask(Q, { state: {} })).model).toBe("b");
    expect([a.calls, b.calls]).toEqual([5, 5]);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe(`provider: gateway unavailable (${code}), using claude`);
  });

  it.each(["http_402", "http_429"])("a direct claude entry's %s still opens its breaker", async (code) => {
    const a = fake(() => new DeciderUnavailable(code));
    const b = fake(() => OK("b"));
    const { d, lines } = build([["claude", a], ["fallback", b]]);
    for (let i = 0; i < 5; i++) expect((await d.ask(Q, { state: {} })).model).toBe("b");
    expect([a.calls, b.calls]).toEqual([2, 5]);
    expect(lines[0]).toBe(`provider: claude unavailable (${code}), using fallback`);
  });

  it.each(["http_500", "key_lookup_failed"])("%s still opens the breaker", async (code) => {
    const a = fake(() => new DeciderUnavailable(code));
    const b = fake(() => OK("b"));
    const { d } = build([["gateway", a], ["claude", b]]);
    for (let i = 0; i < 5; i++) expect((await d.ask(Q, { state: {} })).model).toBe("b");
    expect([a.calls, b.calls]).toEqual([2, 5]);
  });

  it("passes the creator id to the decider it calls", async () => {
    const seen: (string | undefined)[] = [];
    const a: Decider = { ask: async (_q, context) => (seen.push(context.creatorId), OK("a")) };
    const { d } = build([["jev", a]]);
    await d.ask(Q, { state: {}, creatorId: "creator-1" });
    expect(seen).toEqual(["creator-1"]);
  });
});
