import { describe, expect, it } from "vitest";
import { GeneratorError, type GenerateInput, type GenerateResult, type Generator } from "@/platform/ports/generator";
import { FailoverGenerator, withModel } from "./generator";

const INPUT: GenerateInput = { system: { cached: "c", turn: "t" }, messages: [{ role: "user", content: "hi" }], maxTokens: 10, model: "m1" };
const OK = (text: string): GenerateResult => ({
  text,
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
});

function fake(behave: (i: GenerateInput) => GenerateResult | Error) {
  const f = { calls: 0, models: [] as string[], generate: async (i: GenerateInput) => { f.calls++; f.models.push(i.model); const r = behave(i); if (r instanceof Error) throw r; return r; } };
  return f as Generator & { calls: number; models: string[] };
}

function build(list: Array<[string, Generator]>) {
  const clock = { t: 0, now() { return this.t; } };
  const lines: string[] = [];
  const g = new FailoverGenerator(
    list.map(([name, generator]) => ({ name, generator })),
    { failures: 2, windowMs: 60_000, cooldownMs: 30_000, clock },
    (l) => lines.push(l),
  );
  return { g, clock, lines };
}

describe("FailoverGenerator", () => {
  it("falls through to the next generator on GeneratorError", async () => {
    const a = fake(() => new GeneratorError("http_529"));
    const b = fake(() => OK("b"));
    const { g, lines } = build([["claude", a], ["claude-fallback", withModel(b, "m2")]]);
    const r = await g.generate(INPUT);
    expect(r.text).toBe("b");
    expect(b.models).toEqual(["m2"]);
    expect(lines).toEqual(["provider: claude unavailable (http_529), using claude-fallback"]);
  });

  it("skips an open breaker without calling it", async () => {
    const a = fake(() => new GeneratorError("network"));
    const b = fake(() => OK("b"));
    const { g, clock } = build([["claude", a], ["fallback", b]]);
    await g.generate(INPUT);
    await g.generate(INPUT);
    for (let i = 0; i < 4; i++) await g.generate(INPUT);
    expect(a.calls).toBe(2);
    clock.t += 30_000;
    await g.generate(INPUT);
    expect(a.calls).toBe(3);
  });

  it("all unavailable rethrows the last GeneratorError", async () => {
    const a = fake(() => new GeneratorError("network"));
    const b = fake(() => new GeneratorError("http_500"));
    const { g } = build([["claude", a], ["fallback", b]]);
    await expect(g.generate(INPUT)).rejects.toMatchObject({ name: "GeneratorError", code: "http_500" });
  });

  it("a non-outage error propagates without trying the next", async () => {
    const a = fake(() => new RangeError("bug"));
    const b = fake(() => OK("b"));
    const { g } = build([["claude", a], ["fallback", b]]);
    await expect(g.generate(INPUT)).rejects.toBeInstanceOf(RangeError);
    expect(b.calls).toBe(0);
  });
});
