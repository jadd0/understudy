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
