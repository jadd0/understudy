/**
 * A decider that speaks the gateway's OpenAI-compatible `/v1/chat/completions`. It asks the same choice question as
 * `ClaudeDecider` (`shared/choice-tool.ts`) as one OpenAI function tool with a forced `tool_choice`, so the answer
 * is `choices[0].message.tool_calls[0].function.arguments`. The gateway passes `tools` only to OpenAI-format
 * upstreams, so `model` must be one of those (it refuses them for its Anthropic and Gemini routes with a 400, which
 * is `http_400` here and sends the chain to the next decider). The request carries the creator's own gateway key. Any
 * failure is `DeciderUnavailable(<short code>)`: never a body, because a body can echo fan text.
 */
import { DeciderUnavailable, type Decider, type DeciderContext, type DeciderResult, type Question } from "@understudy/engine";
import { resolveKey } from "./generator";
import { GatewayHttpError, postChat } from "./http";
import type { GatewayKeyResolver } from "./keys";
import {
  CHOICE_SYSTEM,
  CHOICE_TOOL,
  CHOICE_TOOL_DESCRIPTION,
  choiceInputSchema,
  choiceMaxTokens,
  choicePrompt,
  parseChoiceAnswers,
} from "../shared/choice-tool";

export interface GatewayDeciderOptions {
  /** The gateway's origin, without `/v1`. */
  readonly baseUrl: string;
  readonly keyFor: GatewayKeyResolver;
  /** A model on an OpenAI-format upstream: the gateway refuses `tools` on its Anthropic and Gemini routes. */
  readonly model: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

interface ChatResponse {
  model?: unknown;
  choices?: { message?: { tool_calls?: { function?: { name?: unknown; arguments?: unknown } }[] } }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

export class GatewayDecider implements Decider {
  constructor(private readonly options: GatewayDeciderOptions) {
    if (!options.baseUrl || !options.model) throw new DeciderUnavailable("not_configured");
  }

  async ask(questions: readonly Question[], context: DeciderContext): Promise<DeciderResult> {
    const key = await resolveKey(this.options.keyFor, context.creatorId);
    if (!key) throw new DeciderUnavailable("not_configured");
    let json: ChatResponse;
    try {
      json = (await postChat(
        this.options.baseUrl,
        key,
        {
          model: this.options.model,
          // Newer OpenAI models take this field and reject `max_tokens`; the gateway reads either.
          max_completion_tokens: choiceMaxTokens(questions),
          messages: [
            { role: "system", content: CHOICE_SYSTEM },
            { role: "user", content: choicePrompt(questions, context.state) },
          ],
          tools: [
            { type: "function", function: { name: CHOICE_TOOL, description: CHOICE_TOOL_DESCRIPTION, parameters: choiceInputSchema(questions) } },
          ],
          tool_choice: { type: "function", function: { name: CHOICE_TOOL } },
        },
        { timeoutMs: this.options.timeoutMs, fetch: this.options.fetch },
      )) as ChatResponse;
    } catch (e) {
      // Code only: the gateway relays the provider's message, which can echo the prompt.
      throw new DeciderUnavailable(e instanceof GatewayHttpError ? e.code : "network");
    }
    const call = json?.choices?.[0]?.message?.tool_calls?.find((c) => c.function?.name === CHOICE_TOOL);
    const args = call?.function?.arguments;
    if (typeof args !== "string") throw new DeciderUnavailable("malformed");
    let input: unknown;
    try {
      input = JSON.parse(args);
    } catch {
      throw new DeciderUnavailable("malformed");
    }
    return {
      answers: parseChoiceAnswers(input, questions),
      model: typeof json.model === "string" && json.model !== "" ? json.model : this.options.model,
      usage: { inputTokens: count(json.usage?.prompt_tokens), outputTokens: count(json.usage?.completion_tokens) },
    };
  }
}
