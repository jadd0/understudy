import { describe, expect, it, vi } from "vitest";
import { GeneratorError, type GenerateInput } from "@understudy/engine";
import { GatewayGenerator } from "./generator";
import { envKeyResolver, type GatewayKeyResolver } from "./keys";

const BASE = "http://gateway.test";
const INPUT: GenerateInput = {
  system: { cached: "You are Juno.", turn: "Keep it short." },
  messages: [
    { role: "user", content: "hey" },
    { role: "assistant", content: "hi you" },
    { role: "user", content: "what are you up to" },
  ],
  maxTokens: 300,
  model: "claude-haiku-5-5",
};

/** A body shaped like the gateway's answer for an OpenAI-format upstream. */
const completion = (over: { content?: string | null; finish?: string; usage?: object | null; model?: string } = {}) => ({
  id: "chatcmpl-recorded",
  object: "chat.completion",
  created: 1,
  model: over.model ?? "claude-haiku-5-5",
  choices: [{ index: 0, message: { role: "assistant", content: over.content === undefined ? "not much, you?" : over.content }, finish_reason: over.finish ?? "stop" }],
  ...(over.usage === null ? {} : { usage: over.usage ?? { prompt_tokens: 120, completion_tokens: 9, total_tokens: 129 } }),
});

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(reply: (n: number) => Response) {
  const seen: Seen[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: JSON.parse(String(init?.body)),
    });
    return reply(seen.length);
  }) as typeof fetch;
  return { f, seen };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ROWS = (rows: { key: string; value: unknown; creatorId: string | null }[]) => ({
  rows: async (q: { keys: string[]; prefixes: string[]; creatorId?: string }) =>
    rows.filter((r) => q.keys.includes(r.key) && (r.creatorId === null || r.creatorId === q.creatorId)),
});

const build = (f: typeof fetch, keyFor: GatewayKeyResolver = async () => "gw_key") => new GatewayGenerator({ baseUrl: BASE, keyFor, timeoutMs: 1000, fetch: f });

describe("GatewayGenerator", () => {
  it("sends_system_then_messages_as_openai_chat", async () => {
    const { f, seen } = fakeFetch(() => json(completion()));
    await build(f).generate(INPUT);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("http://gateway.test/v1/chat/completions");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].body).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 300,
      messages: [
        { role: "system", content: "You are Juno.\n\nKeep it short." },
        { role: "user", content: "hey" },
        { role: "assistant", content: "hi you" },
        { role: "user", content: "what are you up to" },
      ],
    });
  });

  it("a base url that ends in a slash still reaches the chat path", async () => {
    const { f, seen } = fakeFetch(() => json(completion()));
    await new GatewayGenerator({ baseUrl: `${BASE}//`, keyFor: async () => "k", timeoutMs: 1000, fetch: f }).generate(INPUT);
    expect(seen[0].url).toBe("http://gateway.test/v1/chat/completions");
  });

  it("maps_usage_and_cached_tokens", async () => {
    const usage = { prompt_tokens: 1000, completion_tokens: 40, total_tokens: 1040, prompt_tokens_details: { cached_tokens: 800 } };
    const { f } = fakeFetch(() => json(completion({ usage })));
    const out = await build(f).generate(INPUT);
    expect(out.text).toBe("not much, you?");
    // Cached tokens are priced on their own row, so they are not also counted as input.
    expect(out.usage).toEqual({ inputTokens: 200, outputTokens: 40, cacheReadTokens: 800, cacheWriteTokens: 0 });

    const plain = await build(fakeFetch(() => json(completion())).f).generate(INPUT);
    expect(plain.usage).toEqual({ inputTokens: 120, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it("names the model that was asked for, not the dated id the gateway reports", async () => {
    const { f } = fakeFetch(() => json(completion({ model: "claude-haiku-5-5-20261001" })));
    expect((await build(f).generate(INPUT)).model).toBe("claude-haiku-5-5");
  });

  it("maps_finish_reason", async () => {
    const reasons: [string, string][] = [
      ["stop", "end_turn"],
      ["length", "max_tokens"],
      ["content_filter", "refusal"],
    ];
    const got: string[] = [];
    for (const [finish] of reasons) {
      const { f } = fakeFetch(() => json(completion({ finish })));
      got.push((await build(f).generate(INPUT)).stopReason ?? "null");
    }
    expect(got).toEqual(reasons.map(([, mapped]) => mapped));
  });

  it("an empty completion is empty text, not a failure", async () => {
    const { f } = fakeFetch(() => json(completion({ content: null, finish: "length" })));
    expect(await build(f).generate(INPUT)).toMatchObject({ text: "", stopReason: "max_tokens" });
  });

  it("uses_the_creators_key", async () => {
    const env = { KEY_A: "gw_aaaa", KEY_B: "gw_bbbb", GATEWAY_KEY: "gw_platform" };
    const config = ROWS([
      { key: "gateway.key_env", value: "GATEWAY_KEY", creatorId: null },
      { key: "gateway.key_env", value: "KEY_A", creatorId: "creator-a" },
      { key: "gateway.key_env", value: "KEY_B", creatorId: "creator-b" },
    ]);
    const { f, seen } = fakeFetch(() => json(completion()));
    const g = build(f, envKeyResolver(config, env));
    await g.generate({ ...INPUT, creatorId: "creator-a" });
    await g.generate({ ...INPUT, creatorId: "creator-b" });
    await g.generate({ ...INPUT, creatorId: "creator-c" });
    await g.generate(INPUT);
    expect(seen.map((s) => s.headers.authorization)).toEqual(["Bearer gw_aaaa", "Bearer gw_bbbb", "Bearer gw_platform", "Bearer gw_platform"]);
  });

  it("no_key_for_creator_throws_not_configured", async () => {
    const { f, seen } = fakeFetch(() => json(completion()));
    const config = ROWS([
      { key: "gateway.key_env", value: "GATEWAY_KEY", creatorId: null },
      { key: "gateway.key_env", value: "KEY_A", creatorId: "creator-a" },
    ]);
    // creator-a names a variable that holds nothing; the platform variable is set but must not stand in for it.
    const g = build(f, envKeyResolver(config, { GATEWAY_KEY: "gw_platform", KEY_A: "  " }));
    await expect(g.generate({ ...INPUT, creatorId: "creator-a" })).rejects.toMatchObject({ name: "GeneratorError", code: "not_configured" });
    // no platform row and no creator row at all
    const none = build(f, envKeyResolver(ROWS([]), { GATEWAY_KEY: "gw_platform" }));
    await expect(none.generate({ ...INPUT, creatorId: "creator-b" })).rejects.toMatchObject({ code: "not_configured" });
    // a blank key from a custom resolver is no key either
    await expect(build(f, async () => "   ").generate(INPUT)).rejects.toMatchObject({ code: "not_configured" });
    expect(seen).toHaveLength(0);
  });

  it("a resolver that throws is key_lookup_failed, a distinct code, with no request and no message in the error", async () => {
    const { f, seen } = fakeFetch(() => json(completion()));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const broken = build(f, async () => {
        throw new Error("db down postgres://secret@host");
      });
      const err = await broken.generate(INPUT).catch((e: unknown) => e);
      expect(err).toMatchObject({ name: "GeneratorError", code: "key_lookup_failed" });
      expect(String((err as Error).message)).not.toContain("secret");
      expect(warn.mock.calls.flat().join(" ")).not.toContain("secret");
      expect(seen).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("the key sent is the trimmed key", async () => {
    const { f, seen } = fakeFetch(() => json(completion()));
    await build(f, envKeyResolver(ROWS([{ key: "gateway.key_env", value: "GATEWAY_KEY", creatorId: null }]), { GATEWAY_KEY: "  gw_padded\n" })).generate(INPUT);
    expect(seen.map((s) => s.headers.authorization)).toEqual(["Bearer gw_padded"]);
  });

  it("402_429_502_504_map_to_codes_without_body", async () => {
    const SENTINEL = "SENTINEL-fan-text";
    const codes: string[] = [];
    for (const status of [402, 429, 502, 504]) {
      const { f } = fakeFetch(() => json({ error: { message: `upstream said: ${SENTINEL} bearer gw_topsecret`, type: "gateway_error" } }, status));
      const err = await build(f, async () => "gw_topsecret")
        .generate(INPUT)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GeneratorError);
      codes.push((err as GeneratorError).code);
      const shown = JSON.stringify([(err as Error).message, (err as Error).stack, (err as GeneratorError).code]);
      expect(shown).not.toContain(SENTINEL);
      expect(shown).not.toContain("gw_topsecret");
    }
    expect(codes).toEqual(["gateway_budget", "gateway_rate_limited", "http_502", "http_504"]);
  });

  it("a network failure, a timeout and a body that is not JSON are codes", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed: ECONNREFUSED gw_key");
    }) as typeof fetch;
    await expect(build(down).generate(INPUT)).rejects.toMatchObject({ code: "network" });
    const slow = (async (_u: unknown, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof fetch;
    const g = new GatewayGenerator({ baseUrl: BASE, keyFor: async () => "k", timeoutMs: 20, fetch: slow });
    await expect(g.generate(INPUT)).rejects.toMatchObject({ code: "timeout" });
    const html = fakeFetch(() => new Response("<html>bad gateway</html>", { status: 200 })).f;
    await expect(build(html).generate(INPUT)).rejects.toMatchObject({ code: "malformed" });
    const noChoices = fakeFetch(() => json({ id: "x", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })).f;
    await expect(build(noChoices).generate(INPUT)).rejects.toMatchObject({ code: "malformed" });
    const noUsage = fakeFetch(() => json(completion({ usage: null }))).f;
    await expect(build(noUsage).generate(INPUT)).rejects.toMatchObject({ code: "malformed" });
  });
});
