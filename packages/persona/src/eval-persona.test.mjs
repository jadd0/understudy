import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { aggregate, blindPrompt, blindSystem, evalPersona, parseBlind, parseRubric, recordResult, renderSection, rubricPrompt, writeEvalsSection } from "./eval-persona.mjs";
import { TokenBudget, writeJsonl } from "./lib/io.mjs";

const CARD = "## Identity\n- Juno, streamer\n## Voice rules\n- short, lowercase\n## Examples\nx\n";
const goodRubric = JSON.stringify({
  voice: { score: 4, reason: "short and lowercase" },
  fact_consistency: { score: 5, reason: "no claims" },
  natural_pitch: { score: "na", reason: "no sale" },
});

function makeBank({ train = 3, validation = 3, test = 12, realFor = (id) => `hersxx-${id}` } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "persona-eval-"));
  const bankDir = join(dir, "bank");
  const cardDir = join(dir, "card");
  mkdirSync(bankDir);
  mkdirSync(cardDir);
  const mk = (split, n) => Array.from({ length: n }, (_, i) => ({ id: `${split}${String(i).padStart(3, "0")}`, post_shortcode: `P${split}${i}`, text: `@fan ${realFor(`${split}${i}`)}`, replying_to: `COMMENT-${split}-${i}` }));
  const rows = [...mk("train", train), ...mk("validation", validation), ...mk("test", test)];
  writeJsonl(join(bankDir, "replies.jsonl"), rows);
  const ids = (split) => rows.filter((r) => r.id.startsWith(split)).map((r) => r.id);
  writeFileSync(join(bankDir, "splits.json"), JSON.stringify({ replies: { train: ids("train"), validation: ids("validation"), test: ids("test"), style_only: [] } }));
  writeFileSync(join(bankDir, "profile.json"), JSON.stringify({ display_name: "juno" }));
  writeFileSync(join(cardDir, "v2.md"), CARD);
  return { dir, bankDir, cardDir, rows };
}

/** Fake Claude that answers by the kind of call, and records every call it receives. */
function fakeClaude({ blind = () => JSON.stringify({ author: "A", confidence: 0.7, reason: "feels hers" }), rubric = () => goodRubric } = {}) {
  const calls = [];
  return {
    calls,
    complete: async (call) => {
      calls.push(call);
      let text;
      if (call.system?.startsWith("You are a strict evaluator")) text = rubric(call);
      else if (call.system?.startsWith("You are shown an Instagram comment")) text = blind(call);
      else text = "oursxx hello";
      return { text, usage: { input_tokens: 10, output_tokens: 5 } };
    },
  };
}

const run = (bank, claude, extra = {}) =>
  evalPersona({ bankDir: bank.bankDir, cardDir: bank.cardDir, version: 2, claude, genModel: "gen-x", judgeModel: "judge-x", seed: "s1", budget: new TokenBudget(), ...extra });

test("blind_sides_are_seeded_and_balanced", async () => {
  const bank = makeBank({ test: 60 });
  const one = await run(bank, fakeClaude());
  const two = await run(bank, fakeClaude());
  const sides = one.items.map((i) => i.generated_side);
  assert.deepEqual(sides, two.items.map((i) => i.generated_side));
  assert.equal(sides.length, 60);
  const aCount = sides.filter((s) => s === "a").length;
  assert.ok(aCount >= 20 && aCount <= 40, `a count ${aCount}`);
  const other = await run(bank, fakeClaude(), { seed: "s2" });
  assert.notDeepEqual(sides, other.items.map((i) => i.generated_side));
});

test("judge_never_receives_side_label", async () => {
  const bank = makeBank();
  const claude = fakeClaude();
  const result = await run(bank, claude);
  const blindCalls = claude.calls.filter((c) => c.system.startsWith("You are shown an Instagram comment"));
  assert.equal(blindCalls.length, 12);
  for (const call of blindCalls) {
    assert.deepEqual(Object.keys(call).sort(), ["maxTokens", "model", "prompt", "system"]);
    assert.doesNotMatch(call.prompt, /generated|real|bot|human|\bAI\b/i);
    assert.match(call.prompt, /^FAN COMMENT\n.+\n\nREPLY A\n.+\n\nREPLY B\n.+$/s);
    assert.equal(call.system, blindSystem("Juno"));
    assert.doesNotMatch(call.prompt, /@fan/);
  }
  // The recorded side agrees with where the texts were actually placed.
  for (const item of result.items) {
    const call = blindCalls.find((c) => c.prompt.includes(`COMMENT-test-${item.id.slice(4).replace(/^0+(?=\d)/, "")}\n`));
    const [, a, b] = call.prompt.match(/REPLY A\n(.*)\n\nREPLY B\n(.*)$/s);
    assert.equal(item.generated_side === "a" ? a : b, item.generated);
    assert.equal(item.generated_side === "a" ? b : a, item.real);
  }
});

test("judge that always answers A lands near 50% and the A-rate shows it", async () => {
  const bank = makeBank({ test: 60 });
  const result = await run(bank, fakeClaude());
  const { blind } = result.aggregate;
  assert.equal(blind.scored, 60);
  assert.equal(blind.judge_answered_a_rate, 1);
  assert.ok(blind.accuracy > 0.33 && blind.accuracy < 0.67, `accuracy ${blind.accuracy}`);
  assert.ok(blind.wilson95.lower < 0.5 && blind.wilson95.upper > 0.5);
});

test("rubric_judge_never_receives_real_reply", async () => {
  const bank = makeBank();
  const claude = fakeClaude();
  await run(bank, claude);
  const rubricCalls = claude.calls.filter((c) => c.system.startsWith("You are a strict evaluator"));
  assert.equal(rubricCalls.length, 12);
  for (const call of rubricCalls) {
    assert.doesNotMatch(call.system + call.prompt, /hersxx/);
    assert.match(call.prompt, /oursxx hello/);
    assert.match(call.prompt, /CARD SUMMARY\nIdentity/);
    assert.doesNotMatch(call.prompt, /Examples|\nx\n/);
  }
  assert.ok(claude.calls.filter((c) => c.system.startsWith("You are shown")).every((c) => c.prompt.includes("hersxx")));
});

test("malformed_judge_json_is_error_not_score", async () => {
  const bank = makeBank({ test: 4 });
  const cases = [
    ["not json at all", "not_json"],
    [JSON.stringify({ author: "C", confidence: 0.9, reason: "x" }), "bad_author"],
    [JSON.stringify({ author: "A", confidence: 0.3, reason: "x" }), "bad_confidence"],
    [JSON.stringify({ author: "A", confidence: 0.9 }), "wrong_keys"],
  ];
  for (const [text, code] of cases) {
    const result = await run(bank, fakeClaude({ blind: () => text }));
    assert.equal(result.aggregate.blind.scored, 0, code);
    assert.equal(result.aggregate.blind.errors, 4);
    assert.equal(result.aggregate.blind.accuracy, null);
    assert.ok(result.items.every((i) => i.blind === null && i.blind_error === code), code);
    assert.equal(result.aggregate.rubric.scored, 4);
  }
  const badRubric = JSON.parse(goodRubric);
  badRubric.voice.score = 6;
  const result = await run(bank, fakeClaude({ rubric: () => JSON.stringify(badRubric) }));
  assert.equal(result.aggregate.rubric.scored, 0);
  assert.ok(result.items.every((i) => i.rubric === null && i.rubric_error === "bad_score"));
  assert.throws(() => parseRubric(JSON.stringify({ ...JSON.parse(goodRubric), voice: { score: "na", reason: "x" } })));
  assert.equal(parseBlind("```json\n" + JSON.stringify({ author: "B", confidence: 1, reason: "r" }) + "\n```").author, "B");
});

test("aggregate_accuracy_and_rubric_means", () => {
  const rub = (v, f, p) => ({ voice: { score: v, reason: "r" }, fact_consistency: { score: f, reason: "r" }, natural_pitch: { score: p, reason: "r" } });
  const item = (bucket, correct, choice, rubric) => ({ length_bucket: bucket, generated_side: "a", blind: correct === null ? null : { choice, confidence: 0.8, correct }, rubric });
  const agg = aggregate([
    item("<=10", true, "B", rub(5, 4, "na")),
    item("<=10", false, "A", rub(3, 4, 2)),
    item("11-30", true, "B", rub(4, 4, 4)),
    item(">30", true, "B", null),
    item(">30", null, null, null),
  ]);
  assert.equal(agg.blind.scored, 4);
  assert.equal(agg.blind.errors, 1);
  assert.equal(agg.blind.correct, 3);
  assert.equal(agg.blind.accuracy, 0.75);
  assert.equal(agg.blind.judge_answered_a_rate, 0.25);
  assert.deepEqual([agg.blind.by_length["<=10"].n, agg.blind.by_length["<=10"].accuracy, agg.blind.by_length[">30"].accuracy], [2, 0.5, 1]);
  assert.equal(agg.rubric.scored, 3);
  assert.deepEqual(agg.rubric.criteria.voice, { n: 3, na: 0, mean: 4, distribution: { 1: 0, 2: 0, 3: 1, 4: 1, 5: 1 } });
  assert.deepEqual([agg.rubric.criteria.natural_pitch.n, agg.rubric.criteria.natural_pitch.na, agg.rubric.criteria.natural_pitch.mean], [2, 1, 3]);
});

test("an emoji-only real reply lands in the shortest bucket and is reported there", async () => {
  const bank = makeBank({ test: 3, realFor: () => "😂" });
  const result = await run(bank, fakeClaude());
  assert.ok(result.items.every((i) => i.length_bucket === "<=10"));
  assert.equal(result.aggregate.blind.by_length["<=10"].n, 3);
  assert.equal(result.aggregate.blind.by_length[">30"].n, 0);
  assert.equal(result.aggregate.blind.by_length[">30"].accuracy, null);
});

test("only_test_split_ids_are_read", async () => {
  const bank = makeBank();
  const claude = fakeClaude();
  const result = await run(bank, claude);
  const testIds = bank.rows.filter((r) => r.id.startsWith("test")).map((r) => r.id).sort();
  assert.equal(testIds.length, 12);
  assert.deepEqual(result.items.map((i) => i.id).sort(), testIds);
  const sent = claude.calls.map((c) => `${c.system}\n${c.prompt}`).join("\n");
  assert.doesNotMatch(sent, /COMMENT-(train|validation)|hersxx-(train|validation)/);
  for (const id of testIds) assert.ok(sent.includes(`hersxx-test${Number(id.slice(4))}`));
});

test("an interrupted run resumes from the cache without paying again", async () => {
  const bank = makeBank();
  const cacheDir = join(bank.dir, "cache");
  const first = await run(bank, fakeClaude(), { cacheDir });
  assert.equal(first.tokens_this_run.calls, 36);
  const never = { complete: async () => assert.fail("a cached call was paid for again") };
  const budget = new TokenBudget();
  const second = await run(bank, never, { cacheDir, budget });
  assert.equal(budget.used, 0);
  assert.deepEqual(second.items, first.items);
  // A different judge model is a different key: nothing is reused.
  const claude = fakeClaude();
  await run(bank, claude, { cacheDir, judgeModel: "judge-y" });
  assert.equal(claude.calls.length, 24);
});

test("writes_evals_section_between_markers_only", async () => {
  const bank = makeBank({ test: 6 });
  const evalsPath = join(bank.dir, "EVALS.md");
  const before = "# Evals\n\n## Retrieval\n<!-- retrieval:start -->\nkeep me\n<!-- retrieval:end -->\n";
  const after = "\n## Tail\nunchanged\n";
  writeFileSync(evalsPath, `${before}<!-- persona:start -->\nold text\n<!-- persona:end -->${after}`);
  const personaPath = join(bank.dir, "persona.json");
  const v2 = await run(bank, fakeClaude());
  recordResult({ result: v2, personaPath, evalsPath });
  let text = readFileSync(evalsPath, "utf8");
  assert.ok(text.startsWith(before) && text.endsWith(after));
  assert.doesNotMatch(text, /old text/);
  assert.match(text, /### Card v2/);
  assert.equal(text.split("<!-- persona:start -->").length, 2);

  const v1 = await run(bank, fakeClaude(), { version: 1, genModel: "gen-y" }).catch(() => null);
  assert.equal(v1, null, "v1 card missing in this bank is an error, not a silent default");
  writeFileSync(join(bank.cardDir, "v1.md"), CARD);
  const v1b = await run(bank, fakeClaude(), { version: 1, genModel: "gen-y" });
  const persona = recordResult({ result: v1b, personaPath, evalsPath });
  assert.deepEqual(Object.keys(persona.versions).sort(), ["1", "2"]);
  // Analytics reads the flat keys; they follow the newest card version, not the one recorded last.
  assert.equal(persona.summary_card_version, 2);
  assert.deepEqual(persona.rubric, { voice: 4, fact_consistency: 5 });
  assert.deepEqual(Object.keys(persona.blindTest).sort(), ["accuracy", "high", "low", "n"]);
  assert.equal(persona.blindTest.n, 6);
  assert.equal(persona.versions["1"].gen_model, "gen-y");
  assert.equal(persona.versions["2"].gen_model, "gen-x");
  text = readFileSync(evalsPath, "utf8");
  assert.ok(text.startsWith(before) && text.endsWith(after));
  assert.ok(text.indexOf("### Card v1") < text.indexOf("### Card v2"));

  // No markers yet: the section is appended, the rest untouched.
  const bare = join(bank.dir, "BARE.md");
  writeFileSync(bare, "# Evals\n\ntext\n");
  writeEvalsSection(bare, renderSection(persona));
  assert.ok(readFileSync(bare, "utf8").startsWith("# Evals\n\ntext\n\n<!-- persona:start -->"));
});

test("prompt templates are the ones the doc quotes", () => {
  assert.match(rubricPrompt({ summary: "S", comment: "C", reply: "R" }), /^CARD SUMMARY\nS\n\nFAN COMMENT\nC\n\nREPLY\nR$/);
  assert.equal(blindPrompt({ comment: "C", a: "x", b: "y" }), "FAN COMMENT\nC\n\nREPLY A\nx\n\nREPLY B\ny");
});
