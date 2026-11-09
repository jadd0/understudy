import { describe, expect, it } from "vitest";
import { AnthropicGenerator } from "@/providers/anthropic/generator";

describe("AnthropicGenerator", () => {
  it("sends Bearer auth, a cached prefix, no temperature, and maps usage", async () => {
    let seen: { headers: Headers; body: Record<string, unknown> } | undefined;
    const fetchImpl = (async (_url: unknown, init: RequestInit) => {
      seen = { headers: new Headers(init.headers), body: JSON.parse(String(init.body)) };
      return new Response(
        JSON.stringify({
          id: "m",
          type: "message",
          role: "assistant",
          model: "claude-haiku-5-5",
          content: [{ type: "text", text: "hey" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const g = new AnthropicGenerator({ authToken: "tok", timeoutMs: 1000, maxRetries: 0, fetch: fetchImpl });
    const r = await g.generate({
      system: { cached: "CARD", turn: "TURN" },
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 50,
      model: "claude-haiku-5-5",
    });
    expect(r.text).toBe("hey");
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 2 });
    expect(seen!.headers.get("authorization")).toBe("Bearer tok");
    expect(seen!.headers.get("x-api-key")).toBeNull();
    expect(seen!.headers.get("anthropic-version")).toBe("2026-10-21");
    expect(seen!.body).not.toHaveProperty("temperature");
    // thinking off: on Haiku 5.5 it is on by default and can spend the whole reply budget
    expect(seen!.body.thinking).toEqual({ type: "disabled" });
    expect(seen!.body.system).toEqual([
      { type: "text", text: "CARD", cache_control: { type: "ephemeral" } },
      { type: "text", text: "TURN" },
    ]);
  });
});
