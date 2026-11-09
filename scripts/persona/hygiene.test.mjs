import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findEmails, findForeignHandles } from "./lib/anonymise.mjs";
import { readJsonl } from "./lib/io.mjs";
import { buildChunks, writeChunks } from "./chunks.mjs";
import { stripLeadingMentions } from "./rapid-eval.mjs";
import { splitReplies } from "./split.mjs";
import { writeStyle } from "./style.mjs";
import { cpSync } from "node:fs";

// Builder-level hygiene: whatever the data, held-out replies never reach the chunks.
function rows() {
  const captions = [];
  const replies = [];
  for (let p = 0; p < 10; p++) {
    const post = `P${p}`;
    captions.push({ id: post, source_url: `https://example.test/p/${post}/`, type: "reel", date: "2026-01-01", caption: `caption ${p}`, description: `scene ${p}`, voice: true });
    for (let k = 0; k < 2; k++) {
      replies.push({ id: `${post}-${k}`, post_shortcode: post, date: "2026-01-02T00:00:00Z", kind: "reply", text: `unique reply text number ${p}-${k}`, non_text: false, replying_to: `fan ${p}-${k}`, replying_to_basis: "exact" });
    }
    replies.push({ id: `${post}-s`, post_shortcode: post, date: "2026-01-02T00:00:00Z", kind: "reply", text: "ty", non_text: false, replying_to: "nice", replying_to_basis: "thread_first" });
  }
  return { captions, replies };
}

test("chunks hold train and style_only replies and no validation or test reply", () => {
  const { captions, replies } = rows();
  const splits = splitReplies(replies, "hygiene-seed");
  const chunks = buildChunks({ captions, replies, splits });
  const chunkIds = new Set(chunks.map((c) => c.id));
  assert.ok(splits.replies.validation.length > 0 && splits.replies.test.length > 0);
  for (const id of [...splits.replies.validation, ...splits.replies.test]) {
    assert.ok(!chunkIds.has(`rep_${id}`), `${id} is held out`);
  }
  for (const id of [...splits.replies.train, ...splits.replies.style_only]) {
    assert.ok(chunkIds.has(`rep_${id}`), `${id} is retrievable`);
  }
  assert.equal(chunks.filter((c) => c.source === "caption").length, 10);
  const held = replies.filter((r) => [...splits.replies.validation, ...splits.replies.test].includes(r.id));
  for (const r of held) assert.ok(!chunks.some((c) => c.text.includes(r.text)), r.text);
});

// ---- Over the committed files under data/persona. A real scrape is gitignored; the only raw
// data committed is the synthetic creator. ----
const DATA = new URL("../../data/persona", import.meta.url).pathname;
const BANK = join(DATA, "bank");
const CARD = join(DATA, "card");
const OWN = ["junovale", "junofilm"];
const MIN_TEXT = 20;
// The card instructs "start with the fan's @mention": generic words, not account names.
const GENERIC_WORDS = new Set(["@mention", "@handle", "@username"]);
const foreign = (text) => findForeignHandles(text, OWN).filter((h) => !GENERIC_WORDS.has(h.toLowerCase()));

function committed() {
  const splits = JSON.parse(readFileSync(join(BANK, "splits.json"), "utf8"));
  const replies = readJsonl(join(BANK, "replies.jsonl"));
  const byId = new Map(replies.map((r) => [r.id, r]));
  const heldOutIds = [...splits.replies.validation, ...splits.replies.test];
  const usedTexts = new Set(
    [...splits.replies.train, ...splits.replies.style_only].map((id) => stripLeadingMentions(byId.get(id).text)),
  );
  // By text only for held-out replies of MIN_TEXT characters or more: "hi" and "ty" also occur in
  // train, so a short text proves nothing. A long held-out text that also occurs verbatim in train is
  // not held-out information, so it is excluded from the text check (ids are still checked).
  const heldOutTexts = heldOutIds
    .map((id) => stripLeadingMentions(byId.get(id).text))
    .filter((t) => t.length >= MIN_TEXT && !usedTexts.has(t));
  return { splits, replies, byId, heldOutIds, heldOutTexts };
}

test("committed data exists and the held-out populations are not empty", () => {
  const { splits, heldOutIds, heldOutTexts } = committed();
  assert.ok(splits.replies.train.length > 0);
  assert.ok(splits.replies.validation.length > 0);
  assert.ok(splits.replies.test.length > 0);
  assert.ok(heldOutIds.length > 0);
  assert.ok(heldOutTexts.length > 0, "some held-out text is long enough to check by text");
});

// Every card version is checked, not only the first: the newest one is what the engine speaks with.
const CARD_VERSIONS = readdirSync(CARD)
  .map((f) => /^v(\d+)\.meta\.json$/.exec(f)?.[1])
  .filter(Boolean)
  .map(Number)
  .sort((x, y) => x - y);

test("at least one card version is committed", () => {
  assert.ok(CARD_VERSIONS.length > 0);
});

for (const version of CARD_VERSIONS) {
  test(`card v${version}: no validation or test reply, by id or by long text, is in the card, its inputs or the chunks`, () => {
    const { heldOutIds, heldOutTexts, splits, byId } = committed();
    const card = readFileSync(join(CARD, `v${version}.md`), "utf8");
    const meta = JSON.parse(readFileSync(join(CARD, `v${version}.meta.json`), "utf8"));
    const chunksRaw = readFileSync(join(BANK, "chunks.jsonl"), "utf8");
    const chunks = readJsonl(join(BANK, "chunks.jsonl"));

    // The checks look at the right place: a train example really is in the card and a train reply in the chunks.
    const trainExample = byId.get(meta.input.example_ids[0]);
    assert.ok(card.includes(stripLeadingMentions(trainExample.text)), "control: an example appears in the card");
    assert.ok(chunks.length > 0 && chunks.some((c) => c.source === "comment_reply"), "control: chunks hold reply pairs");

    const fed = new Set([...meta.input.train_reply_ids, ...meta.input.example_ids, ...(meta.extra_example_ids ?? [])]);
    const trainIds = new Set(splits.replies.train);
    for (const id of fed) assert.ok(trainIds.has(id), `${id} fed to the card is a train reply`);
    for (const id of heldOutIds) {
      assert.ok(!fed.has(id), `${id} not fed to the card`);
      assert.ok(!chunksRaw.includes(id), `${id} not in chunks`);
    }
    for (const text of heldOutTexts) {
      assert.ok(!card.includes(text), `held-out text in card: ${text.slice(0, 30)}`);
      assert.ok(!chunks.some((c) => c.text.includes(text)), `held-out text in chunks: ${text.slice(0, 30)}`);
    }
    for (const c of chunks) {
      if (c.source === "comment_reply") assert.ok(["train", "style_only"].includes(c.split), c.id);
    }
  });
}

test("no @handle other than the creator's own and no email survives in any committed file", () => {
  let files = 0;
  for (const dir of ["bank", "card", "eval"]) {
    // The eval cache directory is gitignored and holds nested files; only the files committed here are scanned.
    for (const entry of readdirSync(join(DATA, dir), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      const text = readFileSync(join(DATA, dir, name), "utf8");
      files++;
      assert.deepEqual(foreign(text), [], `${dir}/${name}`);
      assert.deepEqual(findEmails(text), [], `${dir}/${name}`);
    }
  }
  const evalText = readFileSync("docs/evals/persona.json", "utf8");
  assert.deepEqual(foreign(evalText), [], "docs/evals/persona.json");
  assert.deepEqual(findEmails(evalText), [], "docs/evals/persona.json");
  assert.ok(files >= 10, "scanned the committed files");
});

test("splits, style and chunks rebuild byte-identically from the committed bank", () => {
  const work = mkdtempSync(join(tmpdir(), "persona-det-"));
  for (const name of ["captions.jsonl", "replies.jsonl", "profile.json", "splits.json"]) cpSync(join(BANK, name), join(work, name));
  const seed = JSON.parse(readFileSync(join(BANK, "splits.json"), "utf8")).seed;
  const rebuiltSplits = splitReplies(readJsonl(join(BANK, "replies.jsonl")), seed);
  assert.equal(JSON.stringify(rebuiltSplits, null, 2) + "\n", readFileSync(join(BANK, "splits.json"), "utf8"));
  writeStyle({ bankDir: work });
  writeChunks({ bankDir: work });
  for (const name of ["style.json", "chunks.jsonl"]) {
    assert.equal(readFileSync(join(work, name), "utf8"), readFileSync(join(BANK, name), "utf8"), name);
  }
});

test("every committed raw record is synthetic", () => {
  const raw = join(DATA, "raw");
  const handles = readdirSync(raw, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith("."));
  assert.deepEqual(handles.map((e) => e.name).sort(), [...OWN].sort(), "only the synthetic creator's accounts");
  for (const { name } of handles) {
    assert.equal(JSON.parse(readFileSync(join(raw, name, "profile.json"), "utf8")).synthetic, true, `${name}/profile.json`);
    const posts = readJsonl(join(raw, name, "posts.jsonl"));
    assert.ok(posts.length > 0);
    for (const p of posts) assert.equal(p.synthetic, true, `${name}/${p.shortcode}`);
  }
});
