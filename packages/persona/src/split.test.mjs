import assert from "node:assert/strict";
import { test } from "node:test";
import { splitIndex, splitReplies } from "./split.mjs";

// 20 posts with two exact pairs each, plus a thread_first reply, a GIF and a top-level comment
// on every post, so style_only has a known population.
function fixtureReplies() {
  const rows = [];
  for (let p = 0; p < 20; p++) {
    const post = `P${String(p).padStart(2, "0")}`;
    for (let k = 0; k < 2; k++) {
      rows.push({ id: `${post}-x${k}`, post_shortcode: post, kind: "reply", text: `reply ${p} ${k}`, non_text: false, replying_to: `comment ${p} ${k}`, replying_to_basis: "exact" });
    }
    rows.push({ id: `${post}-t`, post_shortcode: post, kind: "reply", text: "thread", non_text: false, replying_to: "root", replying_to_basis: "thread_first" });
    rows.push({ id: `${post}-g`, post_shortcode: post, kind: "reply", text: "", non_text: true, replying_to: "root", replying_to_basis: "exact" });
    rows.push({ id: `${post}-top`, post_shortcode: post, kind: "top_level", text: "hello", non_text: false, replying_to: null, replying_to_basis: "none" });
  }
  return rows;
}

test("same seed gives the same split, a different seed a different one", () => {
  const rows = fixtureReplies();
  const a = splitReplies(rows, "seed-one");
  const b = splitReplies(rows.slice().reverse(), "seed-one");
  const c = splitReplies(rows, "seed-two");
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.posts, c.posts);
});

test("a post never spans two splits and ids are partitioned exactly", () => {
  const rows = fixtureReplies();
  const splits = splitReplies(rows, "seed-one");
  const index = splitIndex(splits);
  const postSplits = new Map();
  for (const r of rows) {
    const name = index.get(r.id);
    if (name === "style_only") continue;
    assert.ok(name, `${r.id} has a split`);
    const seen = postSplits.get(r.post_shortcode);
    assert.ok(seen === undefined || seen === name, `${r.post_shortcode} stays in ${seen}`);
    postSplits.set(r.post_shortcode, name);
  }
  assert.equal(postSplits.size, 20);
  assert.equal(index.size, rows.length);
  const total = Object.values(splits.replies).reduce((n, list) => n + list.length, 0);
  assert.equal(total, rows.length);
});

test("60/20/20 within one post, and only exact text pairs are split", () => {
  const splits = splitReplies(fixtureReplies(), "seed-one");
  const { train, validation, test: held } = splits.counts.posts;
  assert.ok(Math.abs(train - 12) <= 1 && Math.abs(validation - 4) <= 1 && Math.abs(held - 4) <= 1);
  assert.equal(train + validation + held, 20);
  assert.deepEqual(splits.counts.replies, { train: train * 2, validation: validation * 2, test: held * 2, style_only: 60 });
  for (const id of splits.replies.style_only) assert.match(id, /-(t|g|top)$/);
  for (const name of ["train", "validation", "test"]) {
    assert.ok(splits.replies[name].length > 0, `${name} is not empty`);
    for (const id of splits.replies[name]) assert.match(id, /-x\d$/);
  }
});
