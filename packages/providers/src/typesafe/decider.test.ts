import { describe, expect, it } from "vitest";
import { DeciderUnavailable, TypeSafeNotConfigured, type Question } from "@jadd0/understudy-engine";
import { TypeSafeDecider } from "./decider.js";

const Q: Question[] = [
  { key: "a", prompt: "p", options: [{ key: "yes", label: "y" }, { key: "no", label: "n" }] },
];
const ok = (choice: string) =>
  new Response(
    JSON.stringify({
      model: "jev-x",
      answers: { a: { type: "choice", choice, probabilities: { yes: 0.8, no: 0.2 }, confidence: 0.8 } },
      usage: { input_tokens: 5, output_tokens: 1 },
    }),
    { status: 200 },
  );

function decider(responses: (Response | Error)[]) {
  const bodies: { url: string; headers: Record<string, string>; body: string }[] = [];
  const sleeps: number[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    bodies.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  const d = new TypeSafeDecider({
    apiKey: "k",
    model: "jev-1.14.0",
    timeoutMs: 1000,
    backoffMs: 7,
    fetch: fetchImpl,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { d, bodies, sleeps };
}

describe("TypeSafeDecider", () => {
  it("sends the documented wire shape and parses the answer", async () => {
    const { d, bodies } = decider([ok("yes")]);
    const r = await d.ask(Q, { state: { m: "hi" } });
    expect(bodies[0].url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(bodies[0].headers.Authorization).toBe("Bearer k");
    expect(JSON.parse(bodies[0].body)).toEqual({
      state: { m: "hi" },
      model: "jev-1.14.0",
      questions: { a: { type: "choice", instructions: "p", criteria: { yes: "y", no: "n" } } },
    });
    expect(r.answers[0]).toMatchObject({ key: "a", value: "yes", confidence: 0.8 });
    expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 1 });
  });

  it("retries once on 429 and 529, then gives up", async () => {
    const a = decider([new Response("", { status: 429 }), ok("no")]);
    expect((await a.d.ask(Q, { state: "s" })).answers[0].value).toBe("no");
    expect(a.sleeps).toEqual([7]);
    const b = decider([new Response("", { status: 529 })]);
    await expect(b.d.ask(Q, { state: "s" })).rejects.toMatchObject({ reason: "http_529" });
    expect(b.bodies).toHaveLength(2);
  });

  it("does not retry other statuses", async () => {
    const c = decider([new Response("", { status: 401 })]);
    await expect(c.d.ask(Q, { state: "s" })).rejects.toMatchObject({ reason: "http_401" });
    expect(c.bodies).toHaveLength(1);
  });

  it("maps a network error to timeout and bad answers to malformed", async () => {
    await expect(decider([new Error("x")]).d.ask(Q, { state: "s" })).rejects.toMatchObject({ reason: "timeout" });
    await expect(decider([ok("maybe")]).d.ask(Q, { state: "s" })).rejects.toMatchObject({ reason: "malformed" });
    await expect(decider([new Response("not json")]).d.ask(Q, { state: "s" })).rejects.toBeInstanceOf(
      DeciderUnavailable,
    );
  });

  it("fails closed without a key or model", () => {
    expect(() => new TypeSafeDecider({ apiKey: "", model: "m", timeoutMs: 1, backoffMs: 1, fetch })).toThrow(
      TypeSafeNotConfigured,
    );
  });
});
