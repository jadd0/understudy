import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemble, batchPrompt, MAIN, parseBatch, SIDE, skeleton, synth } from "./synth.mjs";
import { normalise } from "./normalise.mjs";
import { readJsonl, TokenBudget } from "./lib/io.mjs";

const fakeWords = (slots) =>
  new Map(slots.map((s) => [`${s.account}:${s.index}`, {
    caption: `caption ${s.index}`,
    hashtags: [],
    location: null,
    description: "a photo",
    replies: Array.from({ length: s.pairs }, (_, i) => ({ fan: i === 0 ? "[GIF]" : `fan ${i}`, her: `reply ${i}` })),
    top_level: Array.from({ length: s.top_level }, () => "hello all"),
  }]));

test("skeleton is deterministic for a seed and differs across seeds", () => {
  assert.deepEqual(skeleton("a"), skeleton("a"));
  assert.notDeepEqual(skeleton("a")[MAIN].map((s) => s.date), skeleton("b")[MAIN].map((s) => s.date));
});

test("skeleton carries every case normalise branches on", () => {
  const plan = skeleton("juno-2026");
  const main = plan[MAIN];
  assert.equal(main.length, 230);
  assert.equal(plan[SIDE].length, 14);
  assert.ok(main[0].pinned, "the pinned post leads the grid");
  assert.ok(main.some((s) => s.collab_owner), "collabs");
  assert.ok(main.some((s) => s.empty_caption), "empty captions");
  assert.ok(main.filter((s) => s.pairs > 0).length > 80, "posts with replies");
  assert.ok(plan[SIDE].every((s) => s.date >= "2025"), "the side account starts in 2025");
  for (const s of main) if (s.collab_owner) assert.equal(s.empty_caption, false);
});

test("assembled records normalise with both pairing bases, GIFs and collabs", () => {
  const plan = skeleton("juno-2026");
  const raw = mkdtempSync(join(tmpdir(), "synth-"));
  const out = mkdtempSync(join(tmpdir(), "synth-bank-"));
  for (const handle of [MAIN, SIDE]) {
    const posts = assemble(plan[handle], fakeWords(plan[handle]), "juno-2026");
    const dir = join(raw, handle);
    // Same layout synth() writes.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "posts.jsonl"), posts.map((p) => JSON.stringify(p)).join("\n") + "\n");
    writeFileSync(join(dir, "profile.json"), JSON.stringify({ handle, bio: "", links: [] }));
  }
  const { counts, replies } = normalise({ rawDir: raw, outDir: out, creator: MAIN });
  assert.ok(counts.replies_exact > 0 && counts.replies_thread_first > 0);
  assert.ok(counts.collab_captions > 0 && counts.captions_not_voice > counts.collab_captions);
  assert.ok(counts.top_level_comments > 0);
  assert.ok(replies.some((r) => r.replying_to_non_text));
  // Her reply opens with the fan's handle, which normalise turns into @user.
  assert.ok(replies.filter((r) => !r.non_text && r.kind === "reply").every((r) => r.text.startsWith("@user ")));
});

test("parseBatch rejects a short or missing post and tolerates prose around the json", () => {
  const slots = [{ account: MAIN, index: 0, pairs: 2 }];
  const ok = `here you go {"posts":[{"key":"${MAIN}:0","caption":"x","replies":[{"fan":"a","her":"b"},{"fan":"c","her":"d"}]}]} done`;
  assert.equal(parseBatch(ok, slots).size, 1);
  assert.throws(() => parseBatch(`{"posts":[{"key":"${MAIN}:0","replies":[]}]}`, slots), /short replies/);
  assert.throws(() => parseBatch(`{"posts":[]}`, slots), /missing post/);
});

test("batchPrompt names every slot and its reply count", () => {
  const slots = skeleton("juno-2026")[MAIN].slice(0, 3);
  const prompt = batchPrompt(slots);
  for (const s of slots) assert.match(prompt, new RegExp(`"key": "${MAIN}:${s.index}"`));
});

test("synth writes the scraper layout from a fake Claude, resuming from cache", async () => {
  const out = mkdtempSync(join(tmpdir(), "synth-run-"));
  let calls = 0;
  const claude = {
    async complete({ prompt }) {
      calls++;
      const marker = "side account):\n";
      const spec = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length, prompt.indexOf("\n\nAnswer")));
      const posts = spec.map((s) => ({
        key: s.key, caption: "c", hashtags: [], location: null, description: "d",
        replies: Array.from({ length: s.replies }, () => ({ fan: "f", her: "h" })),
        top_level: Array.from({ length: s.her_top_level_comments ?? 0 }, () => "t"),
      }));
      return { text: JSON.stringify({ posts }), usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
  const briefPath = join(out, "brief.md");
  writeFileSync(briefPath, "brief");
  const args = { model: "m", briefPath, outDir: out, seed: "juno-2026", concurrency: 2, claude };
  await synth({ ...args, budget: new TokenBudget() });
  const first = calls;
  assert.ok(first > 0);
  const posts = readJsonl(join(out, MAIN, "posts.jsonl"));
  assert.equal(posts.length, 230);
  assert.ok(posts.every((p) => p.synthetic === true));
  assert.equal(JSON.parse(readFileSync(join(out, MAIN, "profile.json"), "utf8")).synthetic, true);
  await synth({ ...args, budget: new TokenBudget() });
  assert.equal(calls, first, "a second run reads every batch from cache");
});
