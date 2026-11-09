import { describe, expect, test } from "vitest";
import { embed } from "@/providers/voyage/embed";

const vec = (n: number) => Array.from({ length: 1024 }, (_, i) => (i === n ? 1 : 0));
const ok = (n: number) =>
  new Response(JSON.stringify({ data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: vec(i) })), usage: { total_tokens: 7 * n } }), { status: 200 });

describe("voyage embed", () => {
  test("request carries model, input_type, output_dimension and the bearer key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return ok(2);
    }) as unknown as typeof fetch;
    const r = await embed(["a", "b"], "query", { model: "voyage-x", apiKey: "k", fetch: fake });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ input: ["a", "b"], model: "voyage-x", input_type: "query", output_dimension: 1024 });
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(r.embeddings).toHaveLength(2);
    expect(r.embeddings[1][1]).toBe(1);
    expect(r.totalTokens).toBe(14);
  });

  test("429 then 200 retries once; a second failure throws", async () => {
    let n = 0;
    const flaky = (async () => (++n === 1 ? new Response("", { status: 429 }) : ok(1))) as unknown as typeof fetch;
    const r = await embed(["a"], "document", { model: "m", apiKey: "k", fetch: flaky, retryDelayMs: 0 });
    expect(n).toBe(2);
    expect(r.embeddings).toHaveLength(1);

    let m = 0;
    const down = (async () => (m++, new Response("", { status: 503 }))) as unknown as typeof fetch;
    await expect(embed(["a"], "document", { model: "m", apiKey: "k", fetch: down, retryDelayMs: 0 })).rejects.toThrow();
    expect(m).toBe(2);
  });

  test("batches large inputs and keeps order", async () => {
    const sizes: number[] = [];
    const fake = (async (_u: string, init: RequestInit) => {
      const n = JSON.parse(String(init.body)).input.length;
      sizes.push(n);
      return ok(n);
    }) as unknown as typeof fetch;
    const r = await embed(["a", "b", "c", "d", "e"], "document", { model: "m", apiKey: "k", fetch: fake, batchSize: 2 });
    expect(sizes).toEqual([2, 2, 1]);
    expect(r.embeddings).toHaveLength(5);
  });

  test("malformed body, wrong dimension or non-retryable status throws", async () => {
    const mk = (res: () => Response) => (async () => res()) as unknown as typeof fetch;
    const o = { model: "m", apiKey: "k" };
    await expect(embed(["a"], "document", { ...o, fetch: mk(() => new Response("{}", { status: 200 })) })).rejects.toThrow(/malformed/);
    await expect(
      embed(["a"], "document", { ...o, fetch: mk(() => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }), { status: 200 })) }),
    ).rejects.toThrow(/malformed/);
    await expect(embed(["a"], "document", { ...o, fetch: mk(() => new Response("", { status: 401 })) })).rejects.toThrow(/401/);
  });
});
