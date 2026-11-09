// TypeSafe Jev (System One) by plain fetch: choice questions over a JSON state.
//
// Wire contract, read 2026-11-03 from
//   https://docs.typesafe.ai/api.md, https://docs.typesafe.ai/models.md,
//   https://docs.typesafe.ai/primitives/choice.md, https://docs.typesafe.ai/api/errors.md
//
// `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`. Body:
// `{ state, model, questions: { <id>: { type: "choice", instructions, criteria: { <option>: label } } } }`.
// Response: `{ model, answers: { <id>: { type: "choice", choice, probabilities, confidence } },
// usage: { input_tokens, output_tokens } }`. A port of the semantics of umbo's
// packages/providers/src/typesafe/decider.ts: 429 and 529 retry once after backoffMs, every other non-2xx
// throws, and a choice outside the question's criteria or a missing answer is "malformed",
// never defaulted. The model id is always passed in and must be a pinned version, not an alias.
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export class JevError extends Error {
  constructor(code) {
    super(`jev request failed: ${code}`);
    this.name = "JevError";
    this.code = code;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createJev({
  fetch: fetchImpl = globalThis.fetch,
  apiKey = process.env.TYPESAFE_SECRET_KEY,
  backoffMs = 2000,
  timeoutMs = 120_000,
  sleep = defaultSleep,
} = {}) {
  if (!apiKey) throw new JevError("not_configured");

  async function attempt(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** questions: [{ key, prompt, options: [{ key, label }] }]. */
  async function ask({ model, state, questions }) {
    if (!model) throw new JevError("model_required");
    const payload = { state, model, questions: {} };
    for (const question of questions) {
      payload.questions[question.key] = {
        type: "choice",
        instructions: question.prompt,
        criteria: Object.fromEntries(question.options.map((option) => [option.key, option.label])),
      };
    }
    const body = JSON.stringify(payload);

    let response;
    try {
      response = await attempt(body);
    } catch {
      throw new JevError("timeout");
    }
    if (!response.ok && (response.status === 429 || response.status === 529)) {
      await sleep(backoffMs);
      try {
        response = await attempt(body);
      } catch {
        throw new JevError("timeout");
      }
    }
    if (!response.ok) throw new JevError(`http_${response.status}`);

    let json;
    try {
      json = await response.json();
    } catch {
      throw new JevError("malformed");
    }
    const usage = json?.usage;
    if (!json?.answers || typeof usage?.input_tokens !== "number") throw new JevError("malformed");

    const answers = questions.map((question) => {
      const raw = json.answers[question.key];
      const valid = question.options.map((option) => option.key);
      if (!raw || !valid.includes(raw.choice) || typeof raw.confidence !== "number") throw new JevError("malformed");
      return { key: question.key, value: raw.choice, confidence: raw.confidence, probabilities: raw.probabilities };
    });
    return {
      answers,
      model: json.model,
      usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens ?? 0 },
    };
  }

  return { ask };
}
