import { describe, expect, it } from "vitest";
import { DeciderUnavailable, type Question } from "@/platform/ports/decider";
import { ClaudeDecider } from "@/providers/anthropic/decider";

const QUESTIONS: Question[] = [
  { key: "safe", prompt: "Is the fan an adult?", options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }] },
  { key: "intent", prompt: "What does the fan want?", options: [{ key: "chat", label: "Chat" }, { key: "buy", label: "Buy" }, { key: "none", label: "Nothing" }] },
];

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
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function make(respond: (init: RequestInit) => Response | Promise<Response>) {
  type Body = {
    tool_choice: unknown;
    thinking: unknown;
    tools: Array<{ input_schema: { properties: unknown; required: unknown } }>;
    messages: Array<{ content: string }>;
  };
  const seen: Body[] = [];
  const fetchImpl = (async (_u: unknown, init: RequestInit) => {
    seen.push(JSON.parse(String(init.body)) as Body);
    return respond(init);
  }) as unknown as typeof fetch;
  return { seen, decider: new ClaudeDecider({ authToken: "tok", model: "claude-haiku-5-5", timeoutMs: 1000, fetch: fetchImpl }) };
}

describe("ClaudeDecider", () => {
  it("forces the tool and maps each answer to the chosen option", async () => {
    const { seen, decider } = make(() =>
      json(message([{ type: "tool_use", id: "t", name: "answer_questions", input: { safe: "yes", intent: "buy" } }])),
    );
    const r = await decider.ask(QUESTIONS, { state: { fan: "hello" } });
    expect(seen).toHaveLength(1);
    const body = seen[0];
    expect(body.tool_choice).toEqual({ type: "tool", name: "answer_questions" });
    expect(body.tools[0].input_schema.properties).toEqual({
      safe: { type: "string", enum: ["yes", "no"] },
      intent: { type: "string", enum: ["chat", "buy", "none"] },
    });
    expect(body.tools[0].input_schema.required).toEqual(["safe", "intent"]);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.messages[0].content).toContain("Is the fan an adult?");
    expect(body.messages[0].content).toContain("- buy: Buy");
    expect(body.messages[0].content).toContain('{"fan":"hello"}');
    expect(r.answers).toEqual([
      { key: "safe", value: "yes", confidence: 1, probabilities: { yes: 1 } },
      { key: "intent", value: "buy", confidence: 1, probabilities: { buy: 1 } },
    ]);
    expect(r.model).toBe("claude-haiku-5-5");
    expect(r.usage).toEqual({ inputTokens: 120, outputTokens: 14 });
  });

  it("an option outside the enum, a missing key, an HTTP error or a timeout is DeciderUnavailable with a short code", async () => {
    const reason = async (respond: () => Response | Promise<Response>) => {
      const { decider } = make(respond);
      try {
        await decider.ask(QUESTIONS, { state: {} });
      } catch (e) {
        expect(e).toBeInstanceOf(DeciderUnavailable);
        return (e as DeciderUnavailable).reason;
      }
      throw new Error("did not throw");
    };
    const tool = (input: unknown) => json(message([{ type: "tool_use", id: "t", name: "answer_questions", input }]));
    expect(await reason(() => tool({ safe: "maybe", intent: "buy" }))).toBe("malformed");
    expect(await reason(() => tool({ safe: "yes" }))).toBe("malformed");
    expect(await reason(() => json(message([{ type: "text", text: "no tool" }])))).toBe("malformed");
    expect(await reason(() => json({ type: "error", error: { type: "overloaded_error", message: "x" } }, 529))).toBe("http_529");
    expect(await reason(() => json({ type: "error", error: { type: "api_error", message: "x" } }, 500))).toBe("http_500");
    expect(await reason(() => { throw new TypeError("fetch failed"); })).toBe("network");
    const slow = new ClaudeDecider({ authToken: "tok", model: "m", timeoutMs: 20, fetch: ((_u: unknown, init: RequestInit) => new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch });
    await expect(slow.ask(QUESTIONS, { state: {} })).rejects.toMatchObject({ reason: "timeout" });
  });

  it("no fan text appears in the thrown error", async () => {
    const fanText = "my secret fan message 4242";
    const bodies = [
      () => json({ type: "error", error: { type: "invalid_request_error", message: `bad prompt: ${fanText}` } }, 400),
      () => json(message([{ type: "tool_use", id: "t", name: "answer_questions", input: { safe: fanText, intent: "buy" } }])),
    ];
    for (const respond of bodies) {
      const { decider } = make(respond);
      const err = await decider.ask(QUESTIONS, { state: { fan: fanText } }).catch((e) => e as Error);
      expect(err).toBeInstanceOf(DeciderUnavailable);
      expect(`${(err as Error).message} ${(err as Error).stack}`).not.toContain(fanText);
    }
  });
});
