import { describe, expect, it } from "vitest";
import { DeciderUnavailable, type Question } from "@/platform/ports/decider";
import { ClaudeDecider } from "@/providers/anthropic/decider";
import { hardStopOf, parseSafety } from "@/lib/engine/route";
import { SAFETY_KEYS, type RouteCfg } from "@/lib/engine/types";

const QUESTIONS: Question[] = [
  { key: "safe", prompt: "Is the fan an adult?", options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }] },
  { key: "intent", prompt: "What does the fan want?", options: [{ key: "chat", label: "Chat" }, { key: "buy", label: "Buy" }, { key: "none", label: "Nothing" }] },
];

const ok = {
  safe: { choice: "yes", probabilities: { yes: 0.9, no: 0.1 } },
  intent: { choice: "buy", probabilities: { chat: 0.2, buy: 0.7, none: 0.1 } },
};

function message(content: unknown[]) {
  return {
    id: "m",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 14 },
  };
}
const tool = (input: unknown) => json(message([{ type: "tool_use", id: "t", name: "answer_questions", input }]));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Schema = { properties: Record<string, Schema>; required?: unknown; additionalProperties?: unknown };
type Body = {
  tool_choice: unknown;
  thinking: unknown;
  system: string;
  tools: Array<{ input_schema: { properties: Record<string, Schema>; required: unknown } }>;
  messages: Array<{ content: string }>;
};

function make(respond: (init: RequestInit) => Response | Promise<Response>, questions = QUESTIONS) {
  const seen: Body[] = [];
  const fetchImpl = (async (_u: unknown, init: RequestInit) => {
    seen.push(JSON.parse(String(init.body)) as Body);
    return respond(init);
  }) as unknown as typeof fetch;
  void questions;
  return { seen, decider: new ClaudeDecider({ authToken: "tok", model: "claude-haiku-5-5", timeoutMs: 1000, fetch: fetchImpl }) };
}

async function reasonOf(respond: () => Response | Promise<Response>, questions = QUESTIONS) {
  const { decider } = make(respond);
  try {
    await decider.ask(questions, { state: {} });
  } catch (e) {
    expect(e).toBeInstanceOf(DeciderUnavailable);
    return (e as DeciderUnavailable).reason;
  }
  throw new Error("did not throw");
}

describe("ClaudeDecider", () => {
  it("forces the tool and maps each answer to the chosen option with normalised probabilities", async () => {
    const { seen, decider } = make(() => tool({ safe: ok.safe, intent: { choice: "buy", probabilities: { chat: 0.4, buy: 1.4, none: 0.2 } } }));
    const r = await decider.ask(QUESTIONS, { state: { fan: "hello" } });
    expect(seen).toHaveLength(1);
    const body = seen[0];
    expect(body.tool_choice).toEqual({ type: "tool", name: "answer_questions" });
    expect(body.thinking).toEqual({ type: "disabled" });
    const props = body.tools[0].input_schema.properties;
    expect(props.intent.properties.choice).toEqual({ type: "string", enum: ["chat", "buy", "none"] });
    expect(Object.keys(props.intent.properties.probabilities.properties)).toEqual(["chat", "buy", "none"]);
    expect(props.intent.required).toEqual(["choice", "probabilities"]);
    expect(props.intent.additionalProperties).toBe(false);
    expect(props.intent.properties.probabilities.additionalProperties).toBe(false);
    expect(body.tools[0].input_schema.required).toEqual(["safe", "intent"]);
    expect(body.system).toContain("probability");
    expect(body.messages[0].content).toContain("- buy: Buy");
    expect(body.messages[0].content).toContain('{"fan":"hello"}');
    expect(r.answers[0]).toEqual({ key: "safe", value: "yes", confidence: 0.9, probabilities: { yes: 0.9, no: 0.1 } });
    // 0.4 + 1.4 + 0.2 = 2.0, normalised to 0.2 / 0.7 / 0.1
    const intent = r.answers[1];
    expect(intent.value).toBe("buy");
    expect(intent.confidence).toBeCloseTo(0.7);
    expect(Object.values(intent.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(r.model).toBe("claude-haiku-5-5");
    expect(r.usage).toEqual({ inputTokens: 120, outputTokens: 14 });
  });

  it("an option outside the enum, a missing key, an HTTP error or a timeout is DeciderUnavailable with a short code", async () => {
    expect(await reasonOf(() => tool({ ...ok, safe: { ...ok.safe, choice: "maybe" } }))).toBe("malformed");
    expect(await reasonOf(() => tool({ intent: ok.intent }))).toBe("malformed");
    expect(await reasonOf(() => json(message([{ type: "text", text: "no tool" }])))).toBe("malformed");
    expect(await reasonOf(() => json({ type: "error", error: { type: "overloaded_error", message: "x" } }, 529))).toBe("http_529");
    expect(await reasonOf(() => json({ type: "error", error: { type: "api_error", message: "x" } }, 500))).toBe("http_500");
    expect(await reasonOf(() => { throw new TypeError("fetch failed"); })).toBe("network");
    const slow = new ClaudeDecider({
      authToken: "tok",
      model: "claude-haiku-5-5",
      timeoutMs: 20,
      fetch: ((_u: unknown, init: RequestInit) =>
        new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch,
    });
    await expect(slow.ask(QUESTIONS, { state: {} })).rejects.toMatchObject({ reason: "timeout" });
  });

  it("missing, non-numeric or negative probabilities, or a choice that is not the top option, are malformed", async () => {
    const bad = [
      { choice: "yes" },
      { choice: "yes", probabilities: { yes: 0.9 } },
      { choice: "yes", probabilities: { yes: "0.9", no: 0.1 } },
      { choice: "yes", probabilities: { yes: 0.9, no: -0.1 } },
      { choice: "yes", probabilities: { yes: 0, no: 0 } },
      { choice: "yes", probabilities: { yes: 0.3, no: 0.7 } },
      { choice: "no", probabilities: { yes: 0.56, no: 0.44 } },
    ];
    for (const safe of bad) expect(await reasonOf(() => tool({ ...ok, safe })), JSON.stringify(safe)).toBe("malformed");
    // within the tolerance of the top option is accepted
    const { decider } = make(() => tool({ ...ok, safe: { choice: "no", probabilities: { yes: 0.52, no: 0.48 } } }));
    expect((await decider.ask(QUESTIONS, { state: {} })).answers[0].confidence).toBeCloseTo(0.48);
  });

  it("a borderline safety answer reaches the real routing floors as a probability, not a certainty", async () => {
    const questions: Question[] = SAFETY_KEYS.map((key) => ({
      key,
      prompt: key,
      options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }],
    }));
    const floors = { minor: 0.3, self_harm: 0.3, threat: 0.5, location_offplatform: 0.5, payment_dispute: 0.6, hardship: 0.5, intent: 0.5, buyIntentRunnerUp: 1 } as RouteCfg["floors"];
    const answer = (yes: number) => ({ choice: yes >= 0.5 ? "yes" : "no", probabilities: { yes, no: 1 - yes } });
    const run = async (minor: number) => {
      const input = Object.fromEntries(SAFETY_KEYS.map((k) => [k, answer(k === "minor" ? minor : 0.02)]));
      const { decider } = make(() => tool(input));
      return parseSafety(await decider.ask(questions, { state: {} }));
    };
    const borderline = await run(0.4);
    expect(borderline.minor).toBeCloseTo(0.4);
    expect(hardStopOf(borderline, floors)).toMatchObject({ reason: "minor" });
    // below the floor stays below it
    const clear = await run(0.1);
    expect(hardStopOf(clear, floors)).toBeNull();
  });

  it("no fan text appears in the thrown error", async () => {
    const fanText = "my secret fan message 4242";
    const bodies = [
      () => json({ type: "error", error: { type: "invalid_request_error", message: `bad prompt: ${fanText}` } }, 400),
      () => tool({ ...ok, safe: { choice: fanText, probabilities: { yes: 0.5, no: 0.5 } } }),
    ];
    for (const respond of bodies) {
      const { decider } = make(respond);
      const err = await decider.ask(QUESTIONS, { state: { fan: fanText } }).catch((e) => e as Error);
      expect(err).toBeInstanceOf(DeciderUnavailable);
      expect(`${(err as Error).message} ${(err as Error).stack}`).not.toContain(fanText);
    }
  });

  it("refuses a model that rejects a forced tool choice", () => {
    for (const model of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"]) {
      expect(() => new ClaudeDecider({ authToken: "tok", model, timeoutMs: 1000 })).toThrow(/forced tool choice/);
    }
    expect(() => new ClaudeDecider({ authToken: "tok", model: "claude-haiku-5-5", timeoutMs: 1000 })).not.toThrow();
  });
});
