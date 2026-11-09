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

/** A drafter that is only the card and the comment: the node tests cannot load the TypeScript engine (the engine path is tested in eval-persona.engine.test.ts). */
const plainDrafter = async ({ pair, card }) => ({ system: card, prompt: `A fan commented: "${pair.replying_to}"`, draw: null, finish: (t) => t });

const run = (bank, claude, extra = {}) =>
  evalPersona({ bankDir: bank.bankDir, cardDir: bank.cardDir, version: 2, claude, genModel: "gen-x", judgeModel: "judge-x", seed: "s1", budget: new TokenBudget(), drafter: plainDrafter, ...extra });

test("every pair is judged twice, once with the bot in each position", async () => {
  const bank = makeBank({ test: 6 });
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
  assert.equal(result.items.length, 6);
  for (const item of result.items) {
    assert.deepEqual(item.blind.map((b) => b.generated_side), ["a", "b"]);
    // The recorded position agrees with where the texts were actually placed.
    for (const j of item.blind) {
      const call = blindCalls.find((c) => c.prompt.includes(`COMMENT-test-${item.id.slice(4).replace(/^0+(?=\d)/, "")}\n`) && c.prompt.match(/REPLY A\n(.*)\n/)[1] === (j.generated_side === "a" ? item.generated : item.real));
      assert.ok(call, `${item.id} ${j.generated_side}`);
    }
  }
  assert.equal(result.aggregate.blind.scored, 12);
  assert.equal(result.aggregate.blind.generated_in_a_rate, 0.5);
});

test("a judge that always answers A is exactly at 50% and the position split shows it", async () => {
  const bank = makeBank({ test: 20 });
  const { blind } = (await run(bank, fakeClaude())).aggregate;
  assert.equal(blind.scored, 40);
  assert.equal(blind.judge_answered_a_rate, 1);
  assert.equal(blind.accuracy, 0.5);
  assert.deepEqual([blind.by_position.generated_in_a.accuracy, blind.by_position.generated_in_b.accuracy], [0, 1]);
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
    assert.equal(result.aggregate.markers.n, 4);
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
  const j = (side, correct, choice) => ({ generated_side: side, choice, confidence: 0.8, correct });
  const item = (bucket, blind, rubric) => ({ length_bucket: bucket, blind, rubric, real: "r", generated: null });
  const agg = aggregate([
    item("<=10", [j("a", true, "B"), j("b", true, "A")], rub(5, 4, "na")),
    item("<=10", [j("a", false, "A"), j("b", false, "B")], rub(3, 4, 2)),
    item("11-30", [j("a", true, "B"), j("b", true, "A")], rub(4, 4, 4)),
    item(">30", [j("a", true, "B"), j("b", false, "B")], null),
    item(">30", null, null),
  ]);
  assert.equal(agg.blind.scored, 8);
  assert.equal(agg.blind.errors, 1);
  assert.equal(agg.blind.correct, 5);
  assert.equal(agg.blind.accuracy, 0.625);
  assert.equal(agg.blind.judge_answered_a_rate, 0.375);
  assert.deepEqual([agg.blind.by_position.generated_in_a.accuracy, agg.blind.by_position.generated_in_b.accuracy], [0.75, 0.5]);
  assert.deepEqual([agg.blind.by_length["<=10"].n, agg.blind.by_length["<=10"].accuracy, agg.blind.by_length[">30"].accuracy], [4, 0.5, 0.5]);
  assert.equal(agg.rubric.scored, 3);
  assert.deepEqual(agg.rubric.criteria.voice, { n: 3, na: 0, mean: 4, distribution: { 1: 0, 2: 0, 3: 1, 4: 1, 5: 1 } });
  assert.deepEqual([agg.rubric.criteria.natural_pitch.n, agg.rubric.criteria.natural_pitch.na, agg.rubric.criteria.natural_pitch.mean], [2, 1, 3]);
  assert.equal(agg.markers, null);
});

test("per-marker rates are computed for her real replies and the bot's, beside her train rates", () => {
  const item = (real, generated) => ({ length_bucket: "<=10", blind: null, rubric: null, real, generated });
  const train = { signoff_x: 0.13, mate: 0.07 };
  const { markers } = aggregate(
    [item("night x", "night mate x"), item("ok", "hi mate x"), item("lol 😂", "hey mate"), item("fine", "Visit Brighton Pier"), item("skipped", null)],
    { pet: "biscuit", train },
  );
  assert.equal(markers.n, 4);
  assert.deepEqual(markers.rates.signoff_x, { train: 0.13, real: 0.25, bot: 0.5 });
  assert.deepEqual(markers.rates.mate, { train: 0.07, real: 0, bot: 0.75 });
  assert.deepEqual(markers.rates.emoji, { train: null, real: 0.25, bot: 0 });
  assert.equal(markers.rates.concrete_fact.bot, 0.25);
});

test("an item that errors is tried once more, and only once", async () => {
  const bank = makeBank({ test: 3 });
  let blindCalls = 0;
  const flaky = fakeClaude({
    blind: () => {
      blindCalls++;
      return blindCalls <= 2 ? "not json" : JSON.stringify({ author: "A", confidence: 0.7, reason: "x" });
    },
  });
  const result = await run(bank, flaky);
  // the first item failed on its first pass (both orders), then both orders passed on the retry
  assert.ok(result.items.every((i) => i.blind_error === null && i.blind.length === 2));
  const always = fakeClaude({ blind: () => "not json" });
  const failed = await run(bank, always);
  assert.ok(failed.items.every((i) => i.blind === null && i.blind_error === "not_json"));
  assert.equal(always.calls.filter((c) => c.system.startsWith("You are shown")).length, 3 * 2 * 2);
});

test("an emoji-only real reply lands in the shortest bucket and is reported there", async () => {
  const bank = makeBank({ test: 3, realFor: () => "😂" });
  const result = await run(bank, fakeClaude());
  assert.ok(result.items.every((i) => i.length_bucket === "<=10"));
  assert.equal(result.aggregate.blind.by_length["<=10"].n, 6);
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
  assert.equal(first.tokens_this_run.calls, 48);
  const never = { complete: async () => assert.fail("a cached call was paid for again") };
  const budget = new TokenBudget();
  const second = await run(bank, never, { cacheDir, budget });
  assert.equal(budget.used, 0);
  assert.deepEqual(second.items, first.items);
  // A different judge model is a different key: nothing is reused.
  const claude = fakeClaude();
  await run(bank, claude, { cacheDir, judgeModel: "judge-y" });
  assert.equal(claude.calls.length, 36);
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
  assert.equal(persona.blindTest.n, 12);
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
