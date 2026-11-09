import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeError, createClaude } from "./lib/claude.mjs";

const ok = (text = "hi") =>
  new Response(JSON.stringify({ model: "m", stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 5, output_tokens: 2 } }), { status: 200 });
const status = (code) => new Response("{}", { status: code });

function harness(responses) {
  const calls = [];
  const queue = responses.slice();
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return queue.shift();
  };
  return { calls, claude: createClaude({ fetch, apiKey: "test-key", backoffMs: 0, sleep: async () => {} }) };
}

test("the request carries the passed model, version header and no sampling parameters", async () => {
  const { claude, calls } = harness([ok()]);
  const out = await claude.complete({ model: "model-under-test", system: "sys", prompt: "hello", maxTokens: 50 });
  assert.equal(out.text, "hi");
  assert.deepEqual(out.usage, { input_tokens: 5, output_tokens: 2 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, "model-under-test");
  assert.equal(calls[0].body.max_tokens, 50);
  assert.equal(calls[0].body.system, "sys");
  assert.deepEqual(calls[0].body.messages, [{ role: "user", content: "hello" }]);
  for (const forbidden of ["temperature", "top_p", "top_k"]) assert.ok(!(forbidden in calls[0].body));
  assert.equal(calls[0].init.headers["anthropic-version"], "2026-10-21");
  assert.equal(calls[0].init.headers.Authorization, "Bearer test-key");
});

test("429 then 200 retries once", async () => {
  const { claude, calls } = harness([status(429), ok("second")]);
  const out = await claude.complete({ model: "m", prompt: "p", maxTokens: 10 });
  assert.equal(out.text, "second");
  assert.equal(calls.length, 2);
});

test("529 twice throws after exactly one retry", async () => {
  const { claude, calls } = harness([status(529), status(529)]);
  await assert.rejects(claude.complete({ model: "m", prompt: "p", maxTokens: 10 }), (e) => e instanceof ClaudeError && e.code === "http_529");
  assert.equal(calls.length, 2);
});

test("401 never retries", async () => {
  const { claude, calls } = harness([status(401), ok()]);
  await assert.rejects(claude.complete({ model: "m", prompt: "p", maxTokens: 10 }), (e) => e.code === "http_401");
  assert.equal(calls.length, 1);
});

test("a malformed body throws", async () => {
  for (const body of [{ content: [], usage: { input_tokens: 1, output_tokens: 1 } }, { content: [{ type: "text", text: "x" }] }, "not json"]) {
    const response = typeof body === "string" ? new Response(body, { status: 200 }) : new Response(JSON.stringify(body), { status: 200 });
    const { claude } = harness([response]);
    await assert.rejects(claude.complete({ model: "m", prompt: "p", maxTokens: 10 }), (e) => e.code === "malformed");
  }
});

test("a model is required and a missing key fails closed", async () => {
  const { claude, calls } = harness([ok()]);
  await assert.rejects(claude.complete({ prompt: "p", maxTokens: 10 }), (e) => e.code === "model_required");
  assert.equal(calls.length, 0);
  assert.throws(() => createClaude({ fetch: async () => ok(), apiKey: "" }), (e) => e.code === "not_configured");
});
