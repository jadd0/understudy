/**
 * TypeSafe Jev (System One) by REST, no SDK. Wire contract (docs.typesafe.ai/api.md, models.md,
 * primitives/choice.md): POST /v1/systemone with `Authorization: Bearer`, body
 * `{ state, model, questions: { <id>: { type: "choice", instructions, criteria } } }`, response
 * `{ model, answers: { <id>: { choice, probabilities, confidence } }, usage }`.
 * 429 and 529 retry once after `backoffMs`; every other non-2xx fails at once. A choice outside its
 * question's options, a missing answer or an unparseable body is `malformed`, never defaulted.
 */
import {
  DeciderUnavailable,
  TypeSafeNotConfigured,
  type Answer,
  type Decider,
  type DeciderResult,
  type DeciderState,
  type Question,
} from "@/platform/ports/decider";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export interface TypeSafeDeciderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly backoffMs: number;
  readonly fetch: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface WireAnswer {
  readonly choice?: unknown;
  readonly probabilities?: unknown;
  readonly confidence?: unknown;
}

interface WireResponse {
  readonly model?: unknown;
  readonly answers?: Record<string, WireAnswer>;
  readonly usage?: { readonly input_tokens?: unknown; readonly output_tokens?: unknown };
}

export class TypeSafeDecider implements Decider {
  constructor(private readonly options: TypeSafeDeciderOptions) {
    if (!options.apiKey || !options.model) throw new TypeSafeNotConfigured();
  }

  async ask(questions: readonly Question[], context: { readonly state: DeciderState }): Promise<DeciderResult> {
    const payload = JSON.stringify({
      state: context.state,
      model: this.options.model,
      questions: Object.fromEntries(
        questions.map((q) => [
          q.key,
          {
            type: "choice",
            instructions: q.prompt,
            criteria: Object.fromEntries(q.options.map((o) => [o.key, o.label])),
          },
        ]),
      ),
    });

    const attempt = async (): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        return await this.options.fetch(ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
          body: payload,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };

    let response: Response;
    try {
      response = await attempt();
    } catch {
      throw new DeciderUnavailable("timeout");
    }
    if (!response.ok && (response.status === 429 || response.status === 529)) {
      await (this.options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(this.options.backoffMs);
      try {
        response = await attempt();
      } catch {
        throw new DeciderUnavailable("timeout");
      }
    }
    if (!response.ok) throw new DeciderUnavailable(`http_${response.status}`);

    let json: WireResponse;
    try {
      json = (await response.json()) as WireResponse;
    } catch {
      throw new DeciderUnavailable("malformed");
    }
    const usage = json?.usage;
    if (!json?.answers || typeof usage?.input_tokens !== "number") throw new DeciderUnavailable("malformed");

    const answers: Answer[] = questions.map((q) => {
      const raw = json.answers?.[q.key];
      if (!raw || typeof raw.choice !== "string" || typeof raw.confidence !== "number") {
        throw new DeciderUnavailable("malformed");
      }
      if (!q.options.some((o) => o.key === raw.choice)) throw new DeciderUnavailable("malformed");
      const probabilities =
        raw.probabilities && typeof raw.probabilities === "object"
          ? (raw.probabilities as Record<string, number>)
          : { [raw.choice]: raw.confidence };
      return { key: q.key, value: raw.choice, confidence: raw.confidence, probabilities };
    });

    return {
      answers,
      model: typeof json.model === "string" ? json.model : this.options.model,
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
      },
    };
  }
}
