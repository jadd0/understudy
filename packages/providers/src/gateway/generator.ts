/**
 * A generator that speaks the gateway's OpenAI-compatible `/v1/chat/completions`. The stable prefix and the per-turn
 * suffix are joined into one `system` message (the OpenAI format has no cache marker, so nothing is cached by this
 * path). The request carries the creator's own gateway key, so the gateway's budget, rate limit and request log are
 * per creator. Any failure is `GeneratorError(<short code>)`: `http_<status>`, `timeout`, `network`, `malformed`, or
 * `not_configured` when the creator has no key, or `key_lookup_failed` when the key could not be read. There is no retry here; the failover chain is the retry.
 */
import { GeneratorError, type GenerateInput, type GenerateResult, type Generator } from "@jadd0/understudy-engine";
import { count, GatewayHttpError, postChat, type ChatUsage } from "./http.js";
import { resolveKey, type GatewayKeyResolver } from "./keys.js";

export interface GatewayGeneratorOptions {
  /** The gateway's origin, without `/v1`. */
  readonly baseUrl: string;
  readonly keyFor: GatewayKeyResolver;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

interface ChatResponse {
  choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
  usage?: ChatUsage;
}

const FINISH: Record<string, string> = { stop: "end_turn", length: "max_tokens", content_filter: "refusal" };

export class GatewayGenerator implements Generator {
  constructor(private readonly options: GatewayGeneratorOptions) {
    if (!options.baseUrl) throw new GeneratorError("not_configured");
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    let json: ChatResponse;
    try {
      const key = await resolveKey(this.options.keyFor, input.creatorId);
      json = (await postChat(
        this.options.baseUrl,
        key,
        {
          model: input.model,
          max_tokens: input.maxTokens,
          messages: [
            { role: "system", content: [input.system.cached, input.system.turn].filter((s) => s !== "").join("\n\n") },
            ...input.messages.map((m) => ({ role: m.role, content: m.content })),
          ],
        },
        { timeoutMs: this.options.timeoutMs, fetch: this.options.fetch },
      )) as ChatResponse;
    } catch (e) {
      // Code only: the gateway relays the provider's message, which can echo the prompt.
      throw new GeneratorError(e instanceof GatewayHttpError ? e.code : "network");
    }
    const choice = json?.choices?.[0];
    const content = choice?.message?.content;
    if (!choice || !(typeof content === "string" || content === null || content === undefined) || !json.usage) {
      throw new GeneratorError("malformed");
    }
    const prompt = count(json.usage.prompt_tokens);
    const cached = Math.min(count(json.usage.prompt_tokens_details?.cached_tokens), prompt);
    const finish = typeof choice.finish_reason === "string" ? choice.finish_reason : null;
    return {
      text: content ?? "",
      stopReason: finish === null ? null : (FINISH[finish] ?? finish),
      // The model asked for, not the id the gateway reports: a dated or aliased id has no price row.
      model: input.model,
      usage: {
        // Cached tokens are priced at their own rate, so they leave the input count.
        inputTokens: prompt - cached,
        outputTokens: count(json.usage.completion_tokens),
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      },
    };
  }
}
