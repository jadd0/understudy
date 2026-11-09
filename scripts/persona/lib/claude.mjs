// Claude Messages API by plain fetch, no SDK.
//
// Wire contract, read 2026-11-03 from
//   https://platform.claude.com/docs/en/api/messages (POST /v1/messages, body fields model,
//     max_tokens, system, messages; response content[] blocks, stop_reason, usage),
//   https://platform.claude.com/docs/en/api/versioning (anthropic-version 2026-10-21; the
//     temperature, top_p and top_k parameters are removed and rejected, so none is sent),
//   https://platform.claude.com/docs/en/api/overview (Authorization: Bearer <key>).
//
// The model id is always passed in. 429 and 529 retry once after backoffMs; anything else
// that is not 2xx throws. Errors carry a class and a code only: a response body can echo the
// prompt, which holds scraped fan comments.
const ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2026-10-21";

export class ClaudeError extends Error {
  constructor(code, status = null) {
    super(`claude request failed: ${code}`);
    this.name = "ClaudeError";
    this.code = code;
    this.status = status;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createClaude({
  fetch: fetchImpl = globalThis.fetch,
  apiKey = process.env.CLAUDE_SECRET_KEY,
  backoffMs = 2000,
  timeoutMs = 300_000,
  sleep = defaultSleep,
} = {}) {
  if (!apiKey) throw new ClaudeError("not_configured");

  async function attempt(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "anthropic-version": API_VERSION,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** One user turn in, the text of the reply out, with the usage the API reports. */
  async function complete({ model, system, prompt, maxTokens }) {
    if (!model) throw new ClaudeError("model_required");
    const payload = {
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    };
    if (system) payload.system = system;
    const body = JSON.stringify(payload);

    let response;
    try {
      response = await attempt(body);
    } catch {
      throw new ClaudeError("network");
    }
    if (!response.ok && (response.status === 429 || response.status === 529)) {
      await sleep(backoffMs);
      try {
        response = await attempt(body);
      } catch {
        throw new ClaudeError("network");
      }
    }
    if (!response.ok) throw new ClaudeError(`http_${response.status}`, response.status);

    let json;
    try {
      json = await response.json();
    } catch {
      throw new ClaudeError("malformed");
    }
    if (json?.stop_reason === "refusal") throw new ClaudeError("refusal");
    const blocks = Array.isArray(json?.content) ? json.content : null;
    const text = blocks
      ?.filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
    const usage = json?.usage;
    if (!text || !usage || typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") {
      throw new ClaudeError("malformed");
    }
    return {
      text,
      model: json.model,
      stopReason: json.stop_reason ?? null,
      usage: {
        input_tokens:
          usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
        output_tokens: usage.output_tokens,
      },
    };
  }

  return { complete };
}
