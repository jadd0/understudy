import assert from "node:assert/strict";
import { test } from "node:test";
import { TokenBudget } from "./lib/io.mjs";
import { createJev } from "./lib/jev.mjs";
import { aggregate, cardSummary, classify, evaluateItem, stripLeadingMentions } from "./rapid-eval.mjs";

const pair = { id: "r1", post_shortcode: "P1", text: "@user thank u cutie", replying_to: "you are stunning" };
const claude = { complete: async () => ({ text: "  thank u!  ", usage: { input_tokens: 10, output_tokens: 3 } }) };

function jevWith(choice, confidence = 0.9) {
  const fetch = async () =>
    new Response(JSON.stringify({ model: "jev-pinned", answers: { author: { type: "choice", choice, confidence, probabilities: { a: 0.5, b: 0.5 } } }, usage: { input_tokens: 30, output_tokens: 0 } }), { status: 200 });
  return createJev({ fetch, apiKey: "k", backoffMs: 0, sleep: async () => {} });
}

const run = (jev, generatedSide = "b") =>
  evaluateItem({ pair, generatedSide, card: "card", summary: "sum", claude, jev, genModel: "g", jevModel: "j", budget: new TokenBudget(), personaName: "Isa" });

test("classification: picking the generated reply, or low confidence, is indistinguishable", () => {
  assert.equal(classify({ choice: "b", confidence: 0.95, generatedSide: "b" }), "indistinguishable");
  assert.equal(classify({ choice: "a", confidence: 0.6, generatedSide: "b" }), "indistinguishable");
  assert.equal(classify({ choice: "a", confidence: 0.61, generatedSide: "b" }), "detected");
});

test("a Jev choice outside the criteria is an error item and is never scored", async () => {
  const item = await run(jevWith("c"));
  assert.equal(item.outcome, "error");
  assert.equal(item.error, "malformed");
  assert.equal(item.choice, undefined);
  const agg = aggregate([item, await run(jevWith("a", 0.9), "b"), await run(jevWith("b", 0.9), "b")]);
  assert.deepEqual([agg.n_items, agg.errors, agg.scored, agg.indistinguishable, agg.detected, agg.score], [3, 1, 2, 1, 1, 0.5]);
});

test("the real reply is compared without its leading @mention and sides follow the draw", async () => {
  const item = await run(jevWith("a", 0.9), "b");
  assert.equal(item.real, "thank u cutie");
  assert.equal(item.generated, "thank u!");
  assert.equal(item.outcome, "detected");
  assert.equal(stripLeadingMentions("@user @alice hi there"), "hi there");
});

test("the card summary keeps Identity and Voice rules only", () => {
  const card = "## Identity\n- a\n## Voice rules\n- b\n## Examples\nsecret example\n## Never\n- c\n";
  const summary = cardSummary(card);
  assert.match(summary, /Identity/);
  assert.match(summary, /Voice rules/);
  assert.doesNotMatch(summary, /secret example|Never/);
});
