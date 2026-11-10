import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleCard, SECTIONS } from "./draft-card.mjs";
import { parseJson, pickCandidates } from "./queries.mjs";
import { seededRng } from "./lib/io.mjs";

const pairs = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, replying_to: `fan ${i}`, text: `her reply ${i}` }));
const pairsById = new Map(pairs.map((p) => [p.id, p]));
const body = SECTIONS.map((s) => `## ${s}\n${s === "Examples" ? "<<EXAMPLES>>" : s === "Identity" ? "- from Brighton (src: AAA1)\n- bio (src: profile)" : "x"}`).join("\n");
const raw = (ids) => `${body}\nEXAMPLE_IDS: ${ids.join(", ")}\n`;
const make = (r) => assembleCard({ raw: r, pairsById, shortcodes: new Set(["AAA1"]), personaName: "Juno" });

test("examples are rendered verbatim from the train pairs the model picked", () => {
  const out = make(raw(pairs.slice(0, 15).map((p) => p.id)));
  assert.equal(out.exampleIds.length, 15);
  assert.match(out.card, /\*\*Fan:\*\* fan 3\n\*\*Juno:\*\* her reply 3/);
  assert.doesNotMatch(out.card, /<<EXAMPLES>>|EXAMPLE_IDS/);
  assert.deepEqual(out.warnings, []);
});

test("an example id outside the train pairs is refused", () => {
  const ids = [...pairs.slice(0, 14).map((p) => p.id), "validation-reply"];
  assert.throws(() => make(raw(ids)), /outside the train pairs/);
});

test("too few examples, a missing section and unknown citations are caught", () => {
  assert.throws(() => make(raw(pairs.slice(0, 5).map((p) => p.id))), /expected 15 to 20/);
  assert.throws(() => make(raw(pairs.slice(0, 15).map((p) => p.id)).replace("## Never\nx\n", "")), /card sections/);
  const cited = raw(pairs.slice(0, 15).map((p) => p.id)).replace("(src: AAA1)", "(src: ZZZ9)");
  assert.deepEqual(make(cited).warnings, ["unknown source shortcodes: ZZZ9"]);
});

test("a citation listing several shortcodes splits on commas and semicolons", () => {
  const ids = pairs.slice(0, 15).map((p) => p.id);
  const allKnown = raw(ids).replace("(src: AAA1)", "(src: AAA1; AAA1, AAA1)");
  assert.deepEqual(make(allKnown).warnings, []);
  const oneUnknown = raw(ids).replace("(src: AAA1)", "(src: AAA1; ZZZ9)");
  assert.deepEqual(make(oneUnknown).warnings, ["unknown source shortcodes: ZZZ9"]);
});

test("query helpers: json fences are stripped and anchors are always candidates", () => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  const chunks = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, text: i === 7 ? "beach sunset" : `other thing ${i}` }));
  const candidates = pickCandidates({ question: "any beach sunset nearby", anchors: ["c50"], chunks, rng: seededRng("s") });
  assert.equal(candidates.length, 40);
  assert.equal(new Set(candidates).size, 40);
  assert.ok(candidates.includes("c50"));
  assert.ok(candidates.includes("c7"), "the lexical hit is a candidate");
});

test("stripLeadingMentions removes Instagram's leading @handles and nothing else", async () => {
  const { stripLeadingMentions } = await import("./draft-card.mjs");
  assert.equal(stripLeadingMentions("@user hi babygirl 😍"), "hi babygirl 😍");
  assert.equal(stripLeadingMentions("@user @user.two  w me duh"), "w me duh");
  assert.equal(stripLeadingMentions("ily @user"), "ily @user");
});

// ---- lines mode: a bank with no exact reply pairs ----
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftCard, exampleRange, herLines, MIN_PAIRS } from "./draft-card.mjs";
import { TokenBudget, writeJson, writeJsonl, readJson } from "./lib/io.mjs";
import { fakeCardClaude } from "./testing.mjs";

const captionRow = { id: "exp_1", account: "wren", source_url: null, type: "photo", date: "2026-01-01", caption: "first light", voice: true, collab: false, pinned: false, hashtags: [], location: null, description: "", play_count: null };
const exactPair = (i) => ({ id: `p${i}`, post_shortcode: "exp_1", date: "2026-01-02T00:00:00Z", kind: "reply", text: `@fan${i} her answer ${i}`, non_text: false, replying_to: `fan words ${i}`, replying_to_non_text: false, replying_to_basis: "exact" });
const loose = (id, text, extra = {}) => ({ id, post_shortcode: "exp_1", date: "2026-01-03T00:00:00Z", kind: "top_level", text, non_text: false, replying_to: null, replying_to_non_text: false, replying_to_basis: "none", ...extra });

function makeBank({ train = [], styleOnly = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "draft-card-"));
  const bank = join(dir, "bank");
  writeJsonl(join(bank, "captions.jsonl"), [captionRow]);
  writeJsonl(join(bank, "replies.jsonl"), [...train, ...styleOnly]);
  writeJson(join(bank, "splits.json"), { replies: { train: train.map((r) => r.id), validation: [], test: [], style_only: styleOnly.map((r) => r.id) } });
  writeJson(join(bank, "style.json"), { replies: { n: train.length + styleOnly.length } });
  writeJson(join(bank, "profile.json"), { handle: "wren", display_name: "wren", category: null, bio: "invented", links: [] });
  return { bank, card: join(dir, "card") };
}

const draft = (paths, calls = []) =>
  draftCard({ bankDir: paths.bank, cardDir: paths.card, claude: fakeCardClaude({ calls }), model: "m", version: 1, budget: new TokenBudget(), seed: "s" });

test("under 15 train pairs the prompt carries her lines and no pairs block", async () => {
  const styleOnly = Array.from({ length: 16 }, (_, i) => loose(`s${i}`, i === 0 ? "@moth_fan that means a lot" : `her line number ${i}`));
  styleOnly.push(loose("dup", "her line number 3"), loose("gif", "", { non_text: true }), loose("blank", "@only_a_mention"));
  const paths = makeBank({ train: [exactPair(1), exactPair(2)], styleOnly });
  const calls = [];
  const out = await draft(paths, calls);

  const prompt = calls[0].prompt;
  assert.match(prompt, /=== HER LINES \(her own comments; the comment each answered is not known\) ===\n\[p1\] Wren: her answer 1/);
  assert.doesNotMatch(prompt, /=== PAIRS/);
  assert.match(prompt, /write EXAMPLE_IDS: followed by 15 to 18 comma-separated line ids from the list of her lines below/);
  assert.doesNotMatch(prompt, /reply pair ids/);
  // The mention Instagram inserts is gone, a repeated wording and a GIF are left out.
  assert.match(prompt, /\[s0\] Wren: that means a lot\n/);
  assert.equal(prompt.match(/her line number 3\n/g).length, 1);
  assert.doesNotMatch(prompt, /\[gif\]|\[blank\]|\[dup\]/);

  assert.equal(out.exampleIds.length, 15);
  assert.match(out.card, /\*\*Wren:\*\* her answer 1\n\n\*\*Wren:\*\* her answer 2\n\n\*\*Wren:\*\* that means a lot/);
  assert.doesNotMatch(out.card, /\*\*Fan:\*\*|<<EXAMPLES>>|EXAMPLE_IDS/);
  const meta = readJson(join(paths.card, "v1.meta.json"));
  assert.equal(meta.input.example_mode, "lines");
  assert.equal(meta.input.line_ids.length, 18);
});

test("an example id outside her lines is refused", async () => {
  const paths = makeBank({ styleOnly: Array.from({ length: 16 }, (_, i) => loose(`s${i}`, `line ${i}`)) });
  const claude = fakeCardClaude();
  const wrap = {
    complete: async (args) => {
      const reply = await claude.complete(args);
      return { ...reply, text: reply.text.replace(/s0\b/, "not-hers") };
    },
  };
  await assert.rejects(
    () => draftCard({ bankDir: paths.bank, cardDir: paths.card, claude: wrap, model: "m", version: 1, budget: new TokenBudget(), seed: "s" }),
    /outside her lines/,
  );
});

test("with no lines at all the card says there are no examples and an empty EXAMPLE_IDS is accepted", async () => {
  const paths = makeBank({});
  const calls = [];
  const out = await draft(paths, calls);
  assert.match(calls[0].prompt, /write EXAMPLE_IDS: and nothing after it/);
  assert.match(calls[0].prompt, /=== HER LINES .*===\n$/);
  assert.deepEqual(out.exampleIds, []);
  assert.match(out.card, /## Examples\nNo examples: the data holds no lines of hers\.\n/);
});

test("with a few lines the card names all of them", async () => {
  const paths = makeBank({ styleOnly: [loose("a", "one"), loose("b", "two"), loose("c", "three")] });
  const out = await draft(paths);
  assert.deepEqual(out.exampleIds, ["a", "b", "c"]);
  assert.deepEqual(exampleRange(3), { min: 3, max: 3 });
  assert.deepEqual(exampleRange(40), { min: MIN_PAIRS, max: 20 });
});

test("15 or more train pairs use the pairs prompt, unchanged", async () => {
  const paths = makeBank({ train: Array.from({ length: 15 }, (_, i) => exactPair(i)), styleOnly: [loose("s1", "extra line")] });
  const calls = [];
  const out = await draft(paths, calls);
  assert.match(calls[0].prompt, /=== PAIRS \(fan comment and her reply; train split\) ===\n\[p0\] fan: fan words 0\n {4}Wren: @fan0 her answer 0/);
  assert.doesNotMatch(calls[0].prompt, /HER LINES/);
  assert.match(calls[0].prompt, /followed by 15 to 20 comma-separated reply pair ids from the pairs list below/);
  assert.match(out.card, /\*\*Fan:\*\* fan words 0\n\*\*Wren:\*\* her answer 0/);
  assert.equal(readJson(join(paths.card, "v1.meta.json")).input.example_mode, undefined);
});

test("herLines keeps train and style-only text in reply order and leaves the held-out splits out", () => {
  const replies = [exactPair(1), loose("v1", "validation text"), loose("s1", "style text"), loose("t1", "test text")];
  const splits = { replies: { train: ["p1"], validation: ["v1"], test: ["t1"], style_only: ["s1"] } };
  assert.deepEqual(herLines(replies, splits), [{ id: "p1", text: "her answer 1" }, { id: "s1", text: "style text" }]);
});
