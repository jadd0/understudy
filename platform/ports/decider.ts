/**
 * The seam between the engine and whichever model answers its choice questions. Names no provider:
 * no model id, no HTTP. `DeciderUnavailable` is every failure (timeout, http status, malformed answer);
 * its reason is a short machine code, never a body, because a body can echo fan text.
 */
export interface QuestionOption {
  readonly key: string;
  readonly label: string;
}

export interface Question {
  readonly key: string;
  readonly prompt: string;
  readonly options: readonly QuestionOption[];
}

export interface Answer {
  readonly key: string;
  readonly value: string;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

export interface DeciderResult {
  readonly answers: readonly Answer[];
  readonly model: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

/** JSON the model reads. Whatever the engine puts here is what the provider sees; the fence tests pin it. */
export type DeciderState = string | Readonly<Record<string, unknown>> | readonly unknown[];

export interface Decider {
  ask(questions: readonly Question[], context: { readonly state: DeciderState }): Promise<DeciderResult>;
}

export class DeciderUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`DeciderUnavailable: ${reason}`);
    this.name = "DeciderUnavailable";
  }
}

export class TypeSafeNotConfigured extends Error {
  constructor() {
    super("TypeSafe is not configured: an api key and a model id are both required");
    this.name = "TypeSafeNotConfigured";
  }
}

/** The answer to one question, or `DeciderUnavailable("malformed")` when the decider did not return it. */
export function answerOf(result: DeciderResult, key: string): Answer {
  const found = result.answers.find((a) => a.key === key);
  if (!found) throw new DeciderUnavailable("malformed");
  return found;
}
