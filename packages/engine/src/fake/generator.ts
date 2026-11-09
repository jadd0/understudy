import { GeneratorError, type GenerateInput, type GenerateResult, type Generator } from "../ports/generator";

export interface FakeGeneratorOptions {
  /** Replies in order; the last one repeats. A function sees the input. */
  replies?: (string | ((input: GenerateInput) => string))[];
  latch?: (call: number) => Promise<void>;
  /** Throws `GeneratorError(code)` on the n-th call (1-based). */
  failOn?: Record<number, string>;
  stopReason?: string | null;
  /** The model the result names as having served; the requested one when unset. */
  servedModel?: string;
}

export class FakeGenerator implements Generator {
  readonly calls: GenerateInput[] = [];
  replies: (string | ((input: GenerateInput) => string))[];

  constructor(private readonly options: FakeGeneratorOptions = {}) {
    this.replies = options.replies ?? ["hey you"];
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    this.calls.push(input);
    const call = this.calls.length;
    // The reply is chosen when the call arrives, so a latch that holds it cannot change what it says.
    const reply = this.replies[Math.min(call - 1, this.replies.length - 1)];
    const text = typeof reply === "function" ? reply(input) : reply;
    await this.options.latch?.(call);
    const failure = this.options.failOn?.[call];
    if (failure) throw new GeneratorError(failure);
    return {
      text,
      stopReason: this.options.stopReason ?? "end_turn",
      model: this.options.servedModel ?? input.model,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}
