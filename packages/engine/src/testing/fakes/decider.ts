import {
  DeciderUnavailable,
  type Answer,
  type Decider,
  type DeciderContext,
  type DeciderResult,
  type DeciderState,
  type Question,
} from "../../ports/decider.js";

/** What a scripted question answers: a bare choice, a choice with probabilities, or a function of the state. */
export type Scripted =
  | string
  | { value: string; probabilities?: Record<string, number>; confidence?: number }
  | ((state: DeciderState) => string | { value: string; probabilities?: Record<string, number>; confidence?: number });

export interface FakeDeciderOptions {
  /** Answers by question key; a key not scripted falls back to `defaults`, then to the question's last option. */
  script?: Record<string, Scripted>;
  /** Called before every ask resolves; a test holds it to freeze a turn mid-flight. */
  latch?: (call: number, keys: string[]) => Promise<void>;
  /** Throws `DeciderUnavailable(reason)` on the n-th call (1-based). */
  failOn?: Record<number, string>;
}

export class FakeDecider implements Decider {
  readonly calls: { keys: string[]; state: DeciderState; creatorId?: string }[] = [];
  script: Record<string, Scripted>;

  constructor(private readonly options: FakeDeciderOptions = {}) {
    this.script = { ...(options.script ?? {}) };
  }

  async ask(questions: readonly Question[], context: DeciderContext): Promise<DeciderResult> {
    const keys = questions.map((q) => q.key);
    this.calls.push({ keys, state: context.state, creatorId: context.creatorId });
    const call = this.calls.length;
    await this.options.latch?.(call, keys);
    const failure = this.options.failOn?.[call];
    if (failure) throw new DeciderUnavailable(failure);

    const answers: Answer[] = questions.map((q) => {
      const scripted = this.script[q.key];
      const resolved = typeof scripted === "function" ? scripted(context.state) : scripted;
      const picked = typeof resolved === "string" ? { value: resolved } : resolved;
      const value = picked?.value ?? q.options[q.options.length - 1].key;
      if (!q.options.some((o) => o.key === value)) throw new DeciderUnavailable("malformed");
      const confidence = picked?.confidence ?? 0.95;
      const probabilities = picked?.probabilities ?? { [value]: confidence };
      return { key: q.key, value, confidence, probabilities };
    });
    return { answers, model: "fake", usage: { inputTokens: 10, outputTokens: 2 } };
  }
}
