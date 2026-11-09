import assert from "node:assert/strict";
import { test } from "node:test";
import { createJev, JevError } from "./lib/jev.mjs";

const QUESTIONS = [{ key: "who", prompt: "Which is real?", options: [{ key: "a", label: "A is real" }, { key: "b", label: "B is real" }] }];
const answer = (choice, confidence = 0.9) =>
  new Response(JSON.stringify({ model: "jev-x", answers: { who: { type: "choice", choice, confidence, probabilities: { a: 0.1, b: 0.9 } } }, usage: { input_tokens: 40, output_tokens: 0 } }), { status: 200 });
const status = (code) => new Response("{}", { status: code });

function harness(responses) {
  const calls = [];
  const queue = responses.slice();
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return queue.shift();
  };
  return { calls, jev: createJev({ fetch, apiKey: "test-key", backoffMs: 0, sleep: async () => {} }) };
}

test("the request carries the passed model and a choice question with criteria", async () => {
  const { jev, calls } = harness([answer("b")]);
  const out = await jev.ask({ model: "jev-pinned-test", state: { x: 1 }, questions: QUESTIONS });
  assert.equal(calls[0].body.model, "jev-pinned-test");
  assert.deepEqual(calls[0].body.state, { x: 1 });
  assert.deepEqual(calls[0].body.questions.who, { type: "choice", instructions: "Which is real?", criteria: { a: "A is real", b: "B is real" } });
  assert.equal(calls[0].init.headers.Authorization, "Bearer test-key");
  assert.equal(out.answers[0].value, "b");
  assert.equal(out.answers[0].confidence, 0.9);
  assert.deepEqual(out.usage, { input_tokens: 40, output_tokens: 0 });
});

test("429 then 200 retries once; 529 twice throws", async () => {
  const first = harness([status(429), answer("a")]);
  assert.equal((await first.jev.ask({ model: "m", state: {}, questions: QUESTIONS })).answers[0].value, "a");
  assert.equal(first.calls.length, 2);
  const second = harness([status(529), status(529)]);
  await assert.rejects(second.jev.ask({ model: "m", state: {}, questions: QUESTIONS }), (e) => e instanceof JevError && e.code === "http_529");
  assert.equal(second.calls.length, 2);
});

test("a choice outside the criteria, or a missing answer, is malformed", async () => {
  for (const response of [answer("c"), new Response(JSON.stringify({ model: "m", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }), { status: 200 }), new Response("nope", { status: 200 })]) {
    const { jev } = harness([response]);
    await assert.rejects(jev.ask({ model: "m", state: {}, questions: QUESTIONS }), (e) => e.code === "malformed");
  }
});

test("a model is required and 422 never retries", async () => {
  const { jev, calls } = harness([status(422), answer("a")]);
  await assert.rejects(jev.ask({ state: {}, questions: QUESTIONS }), (e) => e.code === "model_required");
  assert.equal(calls.length, 0);
  await assert.rejects(jev.ask({ model: "m", state: {}, questions: QUESTIONS }), (e) => e.code === "http_422");
  assert.equal(calls.length, 1);
});
