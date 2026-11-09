// Voyage embeddings by plain fetch. Wire contract: https://docs.voyageai.com/reference/embeddings-api
// POST /v1/embeddings { input: string[], model, input_type, output_dimension } ->
// { data: [{ embedding: number[], index }], usage: { total_tokens } }.
// Documented limits: at most 1,000 inputs per request; 120K to 1M total tokens depending on model.

export type VoyageInputType = "document" | "query";
export type EmbedResult = { embeddings: number[][]; totalTokens: number };
export type VoyageOptions = {
  model: string;
  dimension?: number;
  apiKey?: string;
  fetch?: typeof fetch;
  /** Texts per request; well under the 1,000-input limit so the token cap is never the binding one. */
  batchSize?: number;
  retryDelayMs?: number;
  /** Retries per request on 429/5xx; default 1. Accounts without billing are limited to 3 requests and 10K tokens a minute. */
  retries?: number;
  /** Pause before every request after the first, to stay under a requests-per-minute limit. */
  intervalMs?: number;
};

const URL_EMBEDDINGS = "https://api.voyageai.com/v1/embeddings";

export class VoyageError extends Error {
  constructor(public readonly status: number, label: string) {
    super(`voyage: ${label}`);
    this.name = "VoyageError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(opts: VoyageOptions, body: unknown): Promise<Response> {
  const f = opts.fetch ?? fetch;
  const key = opts.apiKey ?? process.env.VOYAGE_API_KEY;
  if (!key) throw new VoyageError(0, "VOYAGE_API_KEY is not set");
  const send = () =>
    f(URL_EMBEDDINGS, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
  let res = await send();
  for (let n = 0; n < (opts.retries ?? 1) && (res.status === 429 || res.status >= 500); n++) {
    await sleep(opts.retryDelayMs ?? 1000);
    res = await send();
  }
  return res;
}

/** Embeds `texts` in order. One retry per request on 429/5xx; any other failure or a malformed body throws. */
export async function embed(texts: string[], inputType: VoyageInputType, opts: VoyageOptions): Promise<EmbedResult> {
  const dimension = opts.dimension ?? 1024;
  const size = opts.batchSize ?? 128;
  const embeddings: number[][] = [];
  let totalTokens = 0;
  for (let i = 0; i < texts.length; i += size) {
    if (i > 0 && opts.intervalMs) await sleep(opts.intervalMs);
    const batch = texts.slice(i, i + size);
    const res = await post(opts, {
      input: batch,
      model: opts.model,
      input_type: inputType,
      output_dimension: dimension,
    });
    if (!res.ok) throw new VoyageError(res.status, `request failed with status ${res.status}`);
    const json = (await res.json().catch(() => null)) as {
      data?: { embedding?: unknown; index?: unknown }[];
      usage?: { total_tokens?: unknown };
    } | null;
    const data = json?.data;
    if (!Array.isArray(data) || data.length !== batch.length) throw new VoyageError(res.status, "malformed response");
    const ordered = [...data].sort((a, b) => Number(a.index) - Number(b.index));
    for (const d of ordered) {
      if (!Array.isArray(d.embedding) || d.embedding.length !== dimension || d.embedding.some((x) => typeof x !== "number"))
        throw new VoyageError(res.status, "malformed embedding");
      embeddings.push(d.embedding as number[]);
    }
    totalTokens += typeof json?.usage?.total_tokens === "number" ? json.usage.total_tokens : 0;
  }
  return { embeddings, totalTokens };
}
