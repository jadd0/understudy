/**
 * Claude as the fallback decider, by the official SDK. One Messages call carries the shared choice tool
 * (`shared/choice-tool.ts`) and `tool_choice` forces it. The probabilities are the model's own estimates, not
 * calibrated against Jev. Auth is a Bearer token, as in the generator. Thinking is off because a forced tool choice
 * cannot be combined with it, and the model must be one that accepts a forced tool choice (not Sonnet 5.5, Opus 5.5
 * or Fable 5.1). Any failure is `DeciderUnavailable(<short code>)`: never a body, because a body can echo fan text.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  DeciderUnavailable,
  type Decider,
  type DeciderContext,
  type DeciderResult,
  type Question,
} from "@jadd0/understudy-engine";
import {
  CHOICE_SYSTEM,
  CHOICE_TOOL,
  CHOICE_TOOL_DESCRIPTION,
  choiceInputSchema,
  choiceMaxTokens,
  choicePrompt,
  parseChoiceAnswers,
} from "../shared/choice-tool.js";

export interface ClaudeDeciderOptions {
  readonly authToken: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

/** Models that reject a forced `tool_choice` with a 400. */
const NO_FORCED_TOOL = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"];

export class ClaudeDeciderConfigError extends Error {
  constructor(model: string) {
    super(`model.decide_fallback must accept a forced tool choice; ${model} does not (use claude-haiku-5-5)`);
    this.name = "ClaudeDeciderConfigError";
  }
}

export class ClaudeDecider implements Decider {
  private readonly client: Anthropic;

  constructor(private readonly options: ClaudeDeciderOptions) {
    if (NO_FORCED_TOOL.some((m) => options.model.startsWith(m))) throw new ClaudeDeciderConfigError(options.model);
    if (!options.authToken || !options.model) throw new DeciderUnavailable("not_configured");
    // No SDK retries: the failover layer is the retry.
    this.client = new Anthropic({
      authToken: options.authToken,
      apiKey: null,
      timeout: options.timeoutMs,
      maxRetries: 0,
      fetch: options.fetch,
    });
  }

  async ask(questions: readonly Question[], context: DeciderContext): Promise<DeciderResult> {
    let response;
    try {
      response = await this.client.messages.create({
        model: this.options.model,
        max_tokens: choiceMaxTokens(questions),
        system: CHOICE_SYSTEM,
        messages: [{ role: "user", content: choicePrompt(questions, context.state) }],
        tools: [{ name: CHOICE_TOOL, description: CHOICE_TOOL_DESCRIPTION, input_schema: choiceInputSchema(questions) }],
        tool_choice: { type: "tool", name: CHOICE_TOOL },
        thinking: { type: "disabled" },
      });
    } catch (e) {
      // Class and status only: an error body can echo the prompt, which holds fan text.
      const status = (e as { status?: number }).status;
      throw new DeciderUnavailable(status ? `http_${status}` : e instanceof Anthropic.APIConnectionTimeoutError ? "timeout" : "network");
    }

    const block = response.content.find((b) => b.type === "tool_use" && b.name === CHOICE_TOOL) as
      | { input?: unknown }
      | undefined;
    return {
      answers: parseChoiceAnswers(block?.input, questions),
      model: response.model,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    };
  }
}
