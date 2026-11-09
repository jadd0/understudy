import assert from "node:assert/strict";
import { test } from "node:test";
import { computeStyle, percentile } from "./style.mjs";

const captions = [
  { id: "c1", voice: true, caption: "hello world :3" },
  { id: "c2", voice: true, caption: "ok" },
  { id: "c3", voice: true, caption: "Hi there!" },
  { id: "c4", voice: true, caption: "who knows?" },
  { id: "c5", voice: false, caption: "NOT HER VOICE 🔥🔥" },
];

const reply = (id, text, extra = {}) => ({ id, text, non_text: false, ...extra });
const replies = [
  reply("t1", "@a thanks 😛😛"),
  reply("t2", "@b ur cute xD"),
  reply("t3", "Rawr hola amor"),
  reply("t4", "ok?"),
  reply("v1", "HELLO 🔥🔥🔥🔥"),
  reply("x1", "HELD OUT 🔥"),
  reply("g1", "", { non_text: true }),
];
const splits = {
  replies: { train: ["t1", "t2"], validation: ["v1"], test: ["x1"], style_only: ["t3", "t4", "g1"] },
};

test("caption figures are exact and exclude non-voice captions", () => {
  const { captions: c } = computeStyle({ captions, replies, splits });
  assert.equal(c.n, 4);
  assert.equal(c.lowercase_only_rate, 0.75);
  assert.deepEqual(c.length_chars, { p50: 9, p90: 14 });
  assert.equal(c.emoticons[":3"], 1);
  assert.deepEqual(c.top_emoji, []);
  assert.equal(c.question_rate, 0.25);
  assert.equal(c.exclamation_rate, 0.25);
  assert.equal(c.leading_mention_rate, 0);
});

test("reply figures are exact and exclude validation and test replies", () => {
  const { replies: r } = computeStyle({ captions, replies, splits });
  assert.equal(r.n, 4);
  assert.deepEqual(r.counts, { text_used: 4, non_text: 1, text_held_out: 2 });
  assert.equal(r.lowercase_only_rate, 0.5);
  assert.deepEqual(r.length_chars, { p50: 9, p90: 14 });
  assert.deepEqual(r.top_emoji, [{ emoji: "😛", count: 2 }]);
  assert.deepEqual(r.emoticons, { ":3": 0, ">.<": 0, ":)": 0, xD: 1, rawr: 1 });
  assert.equal(r.leading_mention_rate, 0.5);
  assert.equal(r.question_rate, 0.25);
  assert.equal(r.exclamation_rate, 0);
  // "thanks 😛😛" is one text with emoji, however many it holds
  assert.equal(r.with_emoji_rate, 0.25);
  assert.equal(r.spanish_token_rate, 0.25);
  assert.deepEqual(
    r.top_tokens.map((t) => t.token),
    ["amor", "cute", "hola", "ok", "rawr", "thanks", "ur", "xd"],
  );
});

test("emoticons do not match inside other tokens", () => {
  const { captions: c } = computeStyle({
    captions: [{ id: "c", voice: true, caption: "at 12:30 :) >.< rawrrr xD :3" }],
    replies: [],
    splits: { replies: { train: [], validation: [], test: [], style_only: [] } },
  });
  assert.deepEqual(c.emoticons, { ":3": 1, ">.<": 1, ":)": 1, xD: 1, rawr: 1 });
});

test("percentile is nearest-rank", () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.9), 5);
  assert.equal(percentile([], 0.5), null);
});
