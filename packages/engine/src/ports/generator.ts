export interface GenerateMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface GenerateInput {
  /** `cached` is the stable prefix (persona card and rules) a provider may cache; `turn` changes every call. */
  readonly system: { readonly cached: string; readonly turn: string };
  readonly messages: readonly GenerateMessage[];
  readonly maxTokens: number;
  readonly model: string;
  /** Who the call is for. An adapter that can attribute a call to a creator (a per-creator key, budget or log) uses it; the rest ignore it. */
  readonly creatorId?: string;
}

export interface GenerateUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface GenerateResult {
  readonly text: string;
  readonly usage: GenerateUsage;
  /** "refusal" when the model declined; the text may then be empty. */
  readonly stopReason: string | null;
  /** The model that actually served the call: a failover can answer from a different model than the one asked for. */
  readonly model: string;
}

export interface Generator {
  generate(input: GenerateInput): Promise<GenerateResult>;
}

export class GeneratorError extends Error {
  constructor(readonly code: string) {
    super(`GeneratorError: ${code}`);
    this.name = "GeneratorError";
  }
}
