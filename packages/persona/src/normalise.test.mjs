import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findEmails, findForeignHandles } from "./lib/anonymise.mjs";
import { readJsonl } from "./lib/io.mjs";
import { normalise } from "./normalise.mjs";

const RAW = new URL("../fixtures/raw", import.meta.url).pathname;

function run() {
  const outDir = mkdtempSync(join(tmpdir(), "persona-norm-"));
  const result = normalise({ rawDir: RAW, outDir, creator: "alice" });
  return { outDir, ...result };
}

test("collab captions are facts, not voice", () => {
  const { captions } = run();
  const collab = captions.find((c) => c.id === "AAA2");
  assert.equal(collab.voice, false);
  assert.equal(collab.collab, true);
  assert.equal(collab.description, "Beach.");
  assert.equal(collab.caption, "what a day, @user's pov");
  const own = captions.find((c) => c.id === "AAA1");
  assert.equal(own.voice, true);
  assert.equal(own.description, "Selfie with @user in a car.");
});

test("a record with no caption and no replies is skipped and counted", () => {
  const { captions, counts } = run();
  assert.equal(counts.posts_in, 5);
  assert.equal(counts.skipped_no_caption_no_replies, 1);
  assert.equal(captions.find((c) => c.id === "AAA3"), undefined);
  // A post with no caption but a reply is kept, as a non-voice caption row.
  const kept = captions.find((c) => c.id === "AAA4");
  assert.equal(kept.voice, false);
  assert.equal(kept.collab, false);
});

test("GIF replies are kept with non_text and two in the same second get distinct ids", () => {
  const { replies } = run();
  const gifs = replies.filter((r) => r.non_text);
  assert.equal(gifs.length, 2);
  assert.equal(gifs[0].text, "");
  assert.notEqual(gifs[0].id, gifs[1].id);
  assert.equal(new Set(replies.map((r) => r.id)).size, replies.length);
});

test("replying_to_basis is carried through as exact, thread_first or none", () => {
  const { replies } = run();
  const byText = Object.fromEntries(replies.filter((r) => r.text).map((r) => [r.text, r]));
  assert.equal(byText["@user thank u so much"].replying_to_basis, "exact");
  assert.equal(byText["Rawr xD ok?"].replying_to_basis, "thread_first");
  assert.equal(byText["@alice_alt check this"].replying_to_basis, "none");
  assert.equal(byText["@alice_alt check this"].replying_to, null);
  assert.deepEqual(
    [...new Set(replies.map((r) => r.replying_to_basis))].sort(),
    ["exact", "none", "thread_first"],
  );
});

test("the committed rows carry no foreign handle, email or commenter field", () => {
  const { outDir, replies } = run();
  assert.ok(replies.length > 0);
  for (const name of ["captions.jsonl", "replies.jsonl", "profile.json"]) {
    const text = readFileSync(join(outDir, name), "utf8");
    assert.deepEqual(findForeignHandles(text, ["alice", "alice_alt"]), [], name);
    assert.deepEqual(findEmails(text), [], name);
    assert.doesNotMatch(text, /replying_to_user|tagged_users|carol_fan|bob_tagged|brandco/, name);
  }
  assert.equal(replies.find((r) => r.replying_to?.includes("you look great")).replying_to, "you look great @user");
});

test("output is byte-identical across runs", () => {
  const a = run();
  const b = run();
  for (const name of ["captions.jsonl", "replies.jsonl", "profile.json", "normalise.meta.json"]) {
    assert.equal(readFileSync(join(a.outDir, name), "utf8"), readFileSync(join(b.outDir, name), "utf8"), name);
  }
  assert.equal(readJsonl(join(a.outDir, "captions.jsonl")).length, 4);
});
