/**
 * One POST to the gateway's OpenAI-compatible chat endpoint. Returns the parsed JSON body or throws a
 * `GatewayHttpError` carrying a short code: `http_<status>`, `timeout`, `network` or `malformed`, except that a 402 and a 429
 * are `gateway_budget` and `gateway_rate_limited`: they describe one creator's tenant on the gateway, and a distinct code is
 * how the failover chain tells them from a real Anthropic or Jev 402/429 on its own entries. A response body is never
 * put in an error, because the gateway relays the provider's message and that can echo the prompt, which holds fan text.
 * The key goes in the `authorization` header only.
 */
export class GatewayHttpError extends Error {
  constructor(readonly code: string) {
    super(`GatewayHttpError: ${code}`);
    this.name = "GatewayHttpError";
  }
}

/** The usage block of a chat completion, as far as either adapter reads it. */
export interface ChatUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown };
}

/** A token count from a response field: a finite non-negative number, else 0. */
export const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

export interface PostChatOptions {
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

/** Statuses that speak for one creator's tenant, not for the gateway: a spent budget and a rate limit. */
const PER_CREATOR_STATUS: Readonly<Record<number, string>> = { 402: "gateway_budget", 429: "gateway_rate_limited" };

/** `<baseUrl>/v1/chat/completions`, however many slashes the base ends with. */
export function chatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
}

export async function postChat(baseUrl: string, key: string, body: unknown, options: PostChatOptions): Promise<unknown> {
  const doFetch = options.fetch ?? globalThis.fetch;
  let response: Response;
  let text: string;
  try {
    response = await doFetch(chatUrl(baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    text = await response.text();
  } catch (e) {
    const name = (e as { name?: string }).name;
    throw new GatewayHttpError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
  }
  if (!response.ok) throw new GatewayHttpError(PER_CREATOR_STATUS[response.status] ?? `http_${response.status}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GatewayHttpError("malformed");
  }
}
