/**
 * Claude by the official SDK. Auth is a Bearer token (`authToken`, not `apiKey`, which would send
 * `x-api-key`); the SDK pins `anthropic-version` itself and the current API rejects `temperature`, so none
 * is sent. The system prompt is two blocks: the stable prefix carries `cache_control`, the per-turn suffix does not.
 */
import Anthropic from "@anthropic-ai/sdk";
import { GeneratorError, type GenerateInput, type GenerateResult, type Generator } from "@jadd0/understudy-engine";

export interface AnthropicGeneratorOptions {
  readonly authToken: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly fetch?: typeof fetch;
}

/**
 * The request field that turns thinking off. Sonnet 5.5 rejects `disabled` with a 400 and takes `between_tools`
 * (at effort high or below, with no other field); every other model takes `disabled`.
 */
export function thinkingOff(model: string): { type: "disabled" } | { type: "between_tools" } {
  return model.startsWith("claude-sonnet-5-5") ? { type: "between_tools" } : { type: "disabled" };
}

export class AnthropicGenerator implements Generator {
  private readonly client: Anthropic;

  constructor(options: AnthropicGeneratorOptions) {
    if (!options.authToken) throw new GeneratorError("not_configured");
    this.client = new Anthropic({
      authToken: options.authToken,
      apiKey: null,
      timeout: options.timeoutMs,
      maxRetries: options.maxRetries,
      fetch: options.fetch,
    });
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    let response;
    try {
      response = await this.client.messages.create({
        model: input.model,
        max_tokens: input.maxTokens,
        system: [
          { type: "text", text: input.system.cached, cache_control: { type: "ephemeral" } },
          { type: "text", text: input.system.turn },
        ],
        messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
        // Haiku 5.5 thinks by default and thinking tokens count against max_tokens: a short reply budget could be spent
        // entirely on thinking and return no text (an empty draft, twice, sent a chat to Juno). Chat replies need none.
        thinking: thinkingOff(input.model),
      });
    } catch (e) {
      // Class and status only: an error body can echo the prompt, which holds fan text.
      const status = (e as { status?: number }).status;
      throw new GeneratorError(status ? `http_${status}` : "network");
    }
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    const u = response.usage;
    return {
      text,
      stopReason: response.stop_reason ?? null,
      model: input.model,
      usage: {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
