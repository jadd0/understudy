import { describe, expect, it } from "vitest";
import { DeciderUnavailable, type Question } from "@understudy/engine";
import { GatewayDecider } from "./decider";
import { envKeyResolver, type GatewayKeyResolver } from "./keys";

const BASE = "http://gateway.test";
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

/** A body shaped like the gateway's answer from an OpenAI-format upstream that took the forced tool. */
const toolAnswer = (args: unknown, over: { name?: string; model?: string } = {}) => ({
  id: "chatcmpl-recorded",
  object: "chat.completion",
  model: over.model ?? "gpt-5-mini-2026-01-01",
  choices: [
    {
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: over.name ?? "answer_questions", arguments: typeof args === "string" ? args : JSON.stringify(args) } }],
      },
    },
  ],
  usage: { prompt_tokens: 210, completion_tokens: 31, total_tokens: 241 },
});

const GOOD = { intent: { choice: "buy_intent", probabilities: { smalltalk: 0.1, buy_intent: 0.9 } } };

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(reply: (n: number) => Response) {
  const seen: Seen[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: JSON.parse(String(init?.body)) });
    return reply(seen.length);
  }) as typeof fetch;
  return { f, seen };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const build = (f: typeof fetch, keyFor: GatewayKeyResolver = async () => "gw_key") =>
  new GatewayDecider({ baseUrl: BASE, keyFor, model: "gpt-5-mini", timeoutMs: 1000, fetch: f });

describe("GatewayDecider", () => {
  it("parses_a_tool_call_answer", async () => {
    const { f } = fakeFetch(() => json(toolAnswer(GOOD)));
    const out = await build(f).ask(QUESTIONS, { state: { new_messages: ["show me something"] }, creatorId: "c1" });
    expect(out.answers).toEqual([{ key: "intent", value: "buy_intent", confidence: 0.9, probabilities: { smalltalk: 0.1, buy_intent: 0.9 } }]);
    expect(out.model).toBe("gpt-5-mini-2026-01-01");
    expect(out.usage).toEqual({ inputTokens: 210, outputTokens: 31 });
  });

  it("sends_forced_tool_choice", async () => {
    const { f, seen } = fakeFetch(() => json(toolAnswer(GOOD)));
    await build(f).ask(QUESTIONS, { state: { new_messages: ["hi"] } });
    expect(seen[0].url).toBe("http://gateway.test/v1/chat/completions");
    const body = seen[0].body as {
      model: string;
      messages: { role: string; content: string }[];
      tools: { type: string; function: { name: string; parameters: { required: string[]; properties: Record<string, { properties: { choice: { enum: string[] } } }> } } }[];
      tool_choice: unknown;
    };
    expect(body.model).toBe("gpt-5-mini");
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "answer_questions" } });
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].type).toBe("function");
    expect(body.tools[0].function.name).toBe("answer_questions");
    expect(body.tools[0].function.parameters.required).toEqual(["intent"]);
    expect(body.tools[0].function.parameters.properties.intent.properties.choice.enum).toEqual(["smalltalk", "buy_intent"]);
    expect(body.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(body.messages[1].content).toContain('State (JSON):\n{"new_messages":["hi"]}');
    expect(body.messages[1].content).toContain("Question intent: What does the fan want?");
    expect(seen[0].body).not.toHaveProperty("max_tokens");
    expect(typeof seen[0].body.max_completion_tokens).toBe("number");
  });

  it("text_answer_with_no_tool_call_is_malformed", async () => {
    // The gateway's mock provider answers every request with text and never a tool call.
    const text = { id: "mock", object: "chat.completion", model: "mock-m", choices: [{ index: 0, message: { role: "assistant", content: "tok tok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } };
    const { f } = fakeFetch(() => json(text));
    await expect(build(f).ask(QUESTIONS, { state: "s" })).rejects.toMatchObject({ name: "DeciderUnavailable", reason: "malformed" });
  });

  it("bad_arguments_json_is_malformed", async () => {
    for (const args of ["{not json", JSON.stringify({}), JSON.stringify({ intent: { choice: "nope", probabilities: { smalltalk: 1, buy_intent: 0 } } }), JSON.stringify({ intent: { choice: "smalltalk", probabilities: { smalltalk: 0.1, buy_intent: 0.9 } } })]) {
      const { f } = fakeFetch(() => json(toolAnswer(args)));
      await expect(build(f).ask(QUESTIONS, { state: "s" }), args).rejects.toMatchObject({ reason: "malformed" });
    }
    // A call to some other tool is no answer.
    const { f } = fakeFetch(() => json(toolAnswer(GOOD, { name: "something_else" })));
    await expect(build(f).ask(QUESTIONS, { state: "s" })).rejects.toMatchObject({ reason: "malformed" });
  });

  it("uses_the_creators_key", async () => {
    const config = {
      rows: async (q: { keys: string[]; creatorId?: string }) =>
        [
          { key: "gateway.key_env", value: "GATEWAY_KEY", creatorId: null },
          { key: "gateway.key_env", value: "KEY_A", creatorId: "creator-a" },
        ].filter((r) => q.keys.includes(r.key) && (r.creatorId === null || r.creatorId === q.creatorId)),
    };
    const { f, seen } = fakeFetch(() => json(toolAnswer(GOOD)));
    const d = build(f, envKeyResolver(config, { GATEWAY_KEY: "gw_platform", KEY_A: "gw_aaaa" }));
    await d.ask(QUESTIONS, { state: "s", creatorId: "creator-a" });
    await d.ask(QUESTIONS, { state: "s", creatorId: "creator-b" });
    await d.ask(QUESTIONS, { state: "s" });
    expect(seen.map((s) => s.headers.authorization)).toEqual(["Bearer gw_aaaa", "Bearer gw_platform", "Bearer gw_platform"]);
  });

  it("no key is not_configured and sends nothing", async () => {
    const { f, seen } = fakeFetch(() => json(toolAnswer(GOOD)));
    await expect(build(f, async () => null).ask(QUESTIONS, { state: "s" })).rejects.toMatchObject({ reason: "not_configured" });
    expect(seen).toHaveLength(0);
  });

  it("a gateway that refuses tools for a claude model is http_400 without the body", async () => {
    // Recorded shape of the gateway's refusal for tools on its Anthropic and Gemini routes.
    const refusal = { error: { message: 'The "tools" parameter is not supported for this model. SENTINEL-fan-text', type: "invalid_request_error", param: "tools", code: "unsupported_parameter" } };
    const { f } = fakeFetch(() => json(refusal, 400));
    const err = await new GatewayDecider({ baseUrl: BASE, keyFor: async () => "gw_key", model: "claude-haiku-5-5", timeoutMs: 1000, fetch: f }).ask(QUESTIONS, { state: "s" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeciderUnavailable);
    expect((err as DeciderUnavailable).reason).toBe("http_400");
    expect(String((err as Error).message) + String((err as Error).stack)).not.toContain("SENTINEL");
  });

  it("http errors, network failures and timeouts are codes", async () => {
    const reasons: string[] = [];
    for (const status of [402, 429, 502, 504]) {
      const { f } = fakeFetch(() => json({ error: { message: "SENTINEL" } }, status));
      reasons.push(((await build(f).ask(QUESTIONS, { state: "s" }).catch((e: unknown) => e)) as DeciderUnavailable).reason);
    }
    expect(reasons).toEqual(["http_402", "http_429", "http_502", "http_504"]);
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(build(down).ask(QUESTIONS, { state: "s" })).rejects.toMatchObject({ reason: "network" });
    const slow = (async (_u: unknown, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof fetch;
    await expect(new GatewayDecider({ baseUrl: BASE, keyFor: async () => "k", model: "gpt-5-mini", timeoutMs: 20, fetch: slow }).ask(QUESTIONS, { state: "s" })).rejects.toMatchObject({ reason: "timeout" });
  });
});
