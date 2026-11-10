// Opt-in: the gateway adapters against a real llm-gateway in front of its mock provider (model `mock-m`). No model
// provider is called. Needs LIVE=1, GATEWAY_URL (the gateway's origin, no /v1) and GATEWAY_KEY (a tenant key); the mock's
// control address is GATEWAY_MOCK_URL (default http://127.0.0.1:9000).
//   LIVE=1 GATEWAY_URL=http://127.0.0.1:8080 GATEWAY_KEY=gw_... npx vitest run --config vitest.live.config.mts packages/providers/src/gateway/gateway.live.test.ts
import { describe, expect, test } from "vitest";
import { DeciderUnavailable, GeneratorError, type Question } from "@understudy/engine";
import { GatewayDecider } from "./decider";
import { GatewayGenerator } from "./generator";

const URL_ = process.env.GATEWAY_URL ?? "";
const MOCK = process.env.GATEWAY_MOCK_URL ?? "http://127.0.0.1:9000";
const ENABLED = process.env.LIVE === "1" && URL_ !== "" && Boolean(process.env.GATEWAY_KEY);
const keyFor = async () => process.env.GATEWAY_KEY ?? null;

const QUESTIONS: Question[] = [
  {
    key: "intent",
    prompt: "What does the fan want?",
    options: [
      { key: "smalltalk", label: "chat" },
      { key: "buy_intent", label: "wants to buy" },
    ],
  },
];

const control = (body: object) =>
  fetch(`${MOCK}/__control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe.skipIf(!ENABLED)("live: the gateway adapters against the gateway's mock provider", () => {
  test("the generator gets text and usage back", async () => {
    const generator = new GatewayGenerator({ baseUrl: URL_, keyFor, timeoutMs: 20_000 });
    const out = await generator.generate({
      system: { cached: "You are a test persona.", turn: "Answer in a few words." },
      messages: [{ role: "user", content: "hey" }],
      maxTokens: 20,
      model: "mock-m",
      creatorId: "live-test",
    });
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.usage.inputTokens + out.usage.cacheReadTokens).toBeGreaterThan(0);
    expect(out.usage.outputTokens).toBeGreaterThan(0);
    expect(out.stopReason).toBe("end_turn");
  });

  test("the decider reports a malformed answer, because the mock never returns a tool call", async () => {
    const decider = new GatewayDecider({ baseUrl: URL_, keyFor, model: "mock-m", timeoutMs: 20_000 });
    const err = await decider.ask(QUESTIONS, { state: { new_messages: ["hi"] }, creatorId: "live-test" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeciderUnavailable);
    expect((err as DeciderUnavailable).reason).toBe("malformed");
  });

  test("a mock outage reaches the generator as an http_5xx code", async () => {
    expect((await control({ outage: "error" })).ok).toBe(true);
    try {
      const generator = new GatewayGenerator({ baseUrl: URL_, keyFor, timeoutMs: 20_000 });
      const err = await generator
        .generate({ system: { cached: "c", turn: "t" }, messages: [{ role: "user", content: "hey" }], maxTokens: 20, model: "mock-m" })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GeneratorError);
      expect((err as GeneratorError).code).toMatch(/^http_5\d\d$/);
    } finally {
      await control({ outage: "off" });
    }
  });
});
