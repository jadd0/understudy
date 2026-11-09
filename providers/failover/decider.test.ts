import { describe, expect, it } from "vitest";
import { DeciderUnavailable, type Decider, type DeciderResult, type Question } from "@/platform/ports/decider";
import { FailoverDecider } from "./decider";

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
});
