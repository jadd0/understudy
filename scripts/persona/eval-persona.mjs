// Persona evals on the TEST split, which nothing else reads: for each of her held-out reply pairs,
// Claude (--gen-model) writes a reply with the card as its system prompt, then Claude (--judge-model)
//   1. scores that reply 1-5 on voice, fact consistency and natural pitch (rubric judge), and
//   2. is shown her real reply and the generated one, unlabelled in seeded random order, and says
//      which one is hers (blind test).
// Results go to docs/evals/persona.json and between the persona markers of docs/EVALS.md.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BudgetExceeded, isMain, loadEnvFile, parseArgs, readJson, readJsonl, seededRng, sha16, stableSort, TokenBudget, writeJson } from "./lib/io.mjs";
import { createClaude } from "./lib/claude.mjs";
import { histogram, lengthBucket, LENGTH_BUCKETS, mean, wilson } from "./lib/stats.mjs";
import { capitalise } from "./draft-card.mjs";
import { cardSummary, cleanReply, generateReply } from "./rapid-eval.mjs";

export const RUBRIC_CRITERIA = ["voice", "fact_consistency", "natural_pitch"];
export const MARKERS = { start: "<!-- persona:start -->", end: "<!-- persona:end -->" };

export const rubricSystem = (personaName) => `You are a strict evaluator of an AI persona that replies to fan comments as ${personaName}, an Instagram creator. You are given a summary of her card (who she is and how she writes), a fan's comment, and the persona's reply. Score the reply from 1 to 5 on three criteria. Use the whole scale; 5 is rare.

voice: does the reply sound like the voice the card describes (length, tone, slang, emoji, punctuation, how she opens and closes)? 1 = clearly another voice, 3 = acceptable but generic, 5 = indistinguishable from the card's voice.
fact_consistency: does the reply stay within what the card says about her? 1 = states something the card contradicts, or invents a specific fact (a place, date, plan, relationship or product), 3 = vague or slightly beyond the card, 5 = every claim is supported by the card, or the reply deflects what the card does not cover.
natural_pitch: only when the reply sells, promotes or points the fan to paid content, score how natural it feels. 1 = pushy or out of place, 5 = reads like her. When the reply does not sell or promote anything, answer "na" instead of a number.

Answer with one JSON object and nothing else, in this shape:
{"voice":{"score":<1-5>,"reason":"<one sentence>"},"fact_consistency":{"score":<1-5>,"reason":"<one sentence>"},"natural_pitch":{"score":<1-5 or "na">,"reason":"<one sentence>"}}`;

export const rubricPrompt = ({ summary, comment, reply }) => `CARD SUMMARY
${summary}

FAN COMMENT
${comment}

REPLY
${reply}`;

export const blindSystem = (personaName) => `You are shown an Instagram comment from a fan and two replies to it. One reply was written by ${personaName} herself. The other was written by an AI imitating her. Decide which reply is ${personaName}'s. Judge the writing, not the order: which of the two replies is hers is decided at random.

Answer with one JSON object and nothing else, in this shape:
{"author":"A" or "B","confidence":<number from 0.5 to 1>,"reason":"<one sentence>"}
confidence is how sure you are: 0.5 is a coin flip and 1 is certain.`;

export const blindPrompt = ({ comment, a, b }) => `FAN COMMENT
${comment}

REPLY A
${a}

REPLY B
${b}`;

class JudgeOutputError extends Error {
  constructor(code) {
    super(`judge output rejected: ${code}`);
    this.name = "JudgeOutputError";
    this.code = code;
  }
}

/** The model may wrap its JSON in one code fence; nothing else is tolerated. */
function parseJsonObject(text) {
  const body = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, "$1").trim();
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    throw new JudgeOutputError("not_json");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new JudgeOutputError("not_object");
  return value;
}

const keysOf = (value, allowed) => {
  const keys = Object.keys(value).sort();
  if (keys.join() !== [...allowed].sort().join()) throw new JudgeOutputError("wrong_keys");
};

const reasonOf = (value) => {
  if (typeof value !== "string" || value.trim() === "") throw new JudgeOutputError("bad_reason");
  return value.trim();
};

/** Strict: exactly the three criteria, integer scores 1-5 (natural_pitch may be "na"), a reason each. */
export function parseRubric(text) {
  const raw = parseJsonObject(text);
  keysOf(raw, RUBRIC_CRITERIA);
  const out = {};
  for (const key of RUBRIC_CRITERIA) {
    const entry = raw[key];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new JudgeOutputError("bad_criterion");
    keysOf(entry, ["score", "reason"]);
    const okNa = key === "natural_pitch" && entry.score === "na";
    if (!okNa && !(Number.isInteger(entry.score) && entry.score >= 1 && entry.score <= 5)) throw new JudgeOutputError("bad_score");
    out[key] = { score: entry.score, reason: reasonOf(entry.reason) };
  }
  return out;
}

/** Strict: author "A" or "B", confidence a number from 0.5 to 1, a reason. */
export function parseBlind(text) {
  const raw = parseJsonObject(text);
  keysOf(raw, ["author", "confidence", "reason"]);
  if (raw.author !== "A" && raw.author !== "B") throw new JudgeOutputError("bad_author");
  if (typeof raw.confidence !== "number" || !(raw.confidence >= 0.5 && raw.confidence <= 1)) throw new JudgeOutputError("bad_confidence");
  return { author: raw.author, confidence: raw.confidence, reason: reasonOf(raw.reason) };
}

/** Resumable cache: one small json file per call, keyed by a hash of everything the call depends on. */
function makeCache(dir) {
  return async function cached(keyParts, produce) {
    if (!dir) return produce();
    const path = join(dir, `${sha16(JSON.stringify(keyParts))}.json`);
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")).value;
    const value = await produce();
    writeJson(path, { value });
    return value;
  };
}

const errorCode = (error) => error?.code ?? error?.name ?? "unknown";

export async function evaluateItem({ pair, generatedSide, card, summary, claude, genModel, judgeModel, budget, personaName, cached }) {
  const real = cleanReply(pair.text);
  const base = {
    id: pair.id,
    post_shortcode: pair.post_shortcode,
    fan_comment: pair.replying_to,
    real,
    length_bucket: lengthBucket(real),
    generated: null,
    generated_side: generatedSide,
    rubric: null,
    rubric_error: null,
    blind: null,
    blind_error: null,
  };
  let generated;
  try {
    generated = await cached({ stage: "gen", model: genModel, card: sha16(card), comment: pair.replying_to }, () =>
      generateReply({ claude, model: genModel, card, comment: pair.replying_to, budget }),
    );
    if (real === "" || generated === "") throw new JudgeOutputError("empty_reply");
  } catch (error) {
    if (error instanceof BudgetExceeded) throw error;
    return { ...base, generated: generated ?? null, rubric_error: errorCode(error), blind_error: errorCode(error) };
  }

  const judge = async (stage, system, prompt, parse) => {
    const verdict = await cached({ stage, model: judgeModel, system, prompt }, async () => {
      const response = await claude.complete({ model: judgeModel, system, prompt, maxTokens: 400 });
      budget.addClaude(response.usage);
      return parse(response.text);
    });
    return verdict;
  };

  const [a, b] = generatedSide === "a" ? [generated, real] : [real, generated];
  const [rubric, blind] = await Promise.allSettled([
    judge("rubric", rubricSystem(personaName), rubricPrompt({ summary, comment: pair.replying_to, reply: generated }), parseRubric),
    judge("blind", blindSystem(personaName), blindPrompt({ comment: pair.replying_to, a, b }), parseBlind),
  ]);
  for (const outcome of [rubric, blind]) if (outcome.status === "rejected" && outcome.reason instanceof BudgetExceeded) throw outcome.reason;

  const item = { ...base, generated };
  if (rubric.status === "fulfilled") item.rubric = rubric.value;
  else item.rubric_error = errorCode(rubric.reason);
  if (blind.status === "fulfilled") {
    const realSide = generatedSide === "a" ? "B" : "A";
    item.blind = { choice: blind.value.author, confidence: blind.value.confidence, reason: blind.value.reason, correct: blind.value.author === realSide };
  } else item.blind_error = errorCode(blind.reason);
  return item;
}

const accuracyOf = (items) => {
  const correct = items.filter((i) => i.blind.correct).length;
  return { n: items.length, correct, accuracy: items.length ? Math.round((correct / items.length) * 10000) / 10000 : null, wilson95: wilson(correct, items.length) };
};

export function aggregate(items) {
  const blindItems = items.filter((i) => i.blind);
  const rubricItems = items.filter((i) => i.rubric);
  const rubric = {};
  for (const key of RUBRIC_CRITERIA) {
    const scores = rubricItems.map((i) => i.rubric[key].score).filter((s) => s !== "na");
    rubric[key] = { n: scores.length, na: rubricItems.length - scores.length, mean: mean(scores), distribution: histogram(scores) };
  }
  const bucketOf = (name) => accuracyOf(blindItems.filter((i) => i.length_bucket === name));
  return {
    n_items: items.length,
    rubric: { scored: rubricItems.length, errors: items.length - rubricItems.length, criteria: rubric },
    blind: {
      scored: blindItems.length,
      errors: items.length - blindItems.length,
      ...accuracyOf(blindItems),
      judge_answered_a_rate: blindItems.length ? Math.round((blindItems.filter((i) => i.blind.choice === "A").length / blindItems.length) * 10000) / 10000 : null,
      generated_in_a_rate: items.length ? Math.round((items.filter((i) => i.generated_side === "a").length / items.length) * 10000) / 10000 : null,
      mean_confidence: mean(blindItems.map((i) => i.blind.confidence)),
      by_length: Object.fromEntries(LENGTH_BUCKETS.map((name) => [name, bucketOf(name)])),
    },
  };
}

export async function evalPersona({ bankDir, cardDir, cacheDir, version, claude, genModel, judgeModel, seed, budget, personaName, concurrency = 4, limit = null }) {
  const card = readFileSync(join(cardDir, `v${version}.md`), "utf8");
  const splits = readJson(join(bankDir, "splits.json"));
  const profile = readJson(join(bankDir, "profile.json"));
  const name = personaName ?? capitalise(profile.display_name);
  const testIds = new Set(splits.replies.test);
  let pairs = stableSort(readJsonl(join(bankDir, "replies.jsonl")).filter((r) => testIds.has(r.id)), (r) => r.id);
  if (pairs.length === 0) throw new Error("no test pairs");

  // Sides are drawn up front, in id order, so they do not depend on call timing.
  const rng = seededRng(`${seed}:blind`);
  const sides = pairs.map(() => (rng() < 0.5 ? "a" : "b"));
  if (limit) {
    pairs = pairs.slice(0, limit);
  }
  const summary = cardSummary(card);
  const cached = makeCache(cacheDir);

  const items = new Array(pairs.length);
  let next = 0;
  async function worker() {
    while (next < pairs.length) {
      const i = next++;
      items[i] = await evaluateItem({ pair: pairs[i], generatedSide: sides[i], card, summary, claude, genModel, judgeModel, budget, personaName: name, cached });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  return {
    card_version: version,
    gen_model: genModel,
    judge_model: judgeModel,
    seed,
    card_sha: sha16(card),
    split: "test",
    tokens_this_run: { total: budget.used, claude_input: budget.claudeInput, claude_output: budget.claudeOutput, calls: budget.calls },
    aggregate: aggregate(items),
    items,
  };
}

const pct = (n) => (n === null ? "n/a" : `${(n * 100).toFixed(1)}%`);
const interval = (w) => (w ? `${pct(w.lower)} to ${pct(w.upper)}` : "n/a");

/** The reading is derived from the numbers by rule, so it can never disagree with them. */
export function readingOf(blind) {
  if (blind.scored === 0) return "No blind-test item was scored.";
  const lines = [];
  const { lower, upper } = blind.wilson95;
  if (lower <= 0.5 && upper >= 0.5) lines.push(`The 95% interval (${interval(blind.wilson95)}) includes 50%, so the judge cannot reliably tell her real reply from the bot's on this sample.`);
  else if (lower > 0.5) lines.push(`The 95% interval (${interval(blind.wilson95)}) is above 50%: the judge detects the bot better than chance.`);
  else lines.push(`The 95% interval (${interval(blind.wilson95)}) is below 50%: the judge picks the bot as her more often than her real reply.`);
  if (Math.abs(blind.judge_answered_a_rate - 0.5) > 0.1) lines.push(`The judge answered "A" ${pct(blind.judge_answered_a_rate)} of the time, a position bias that pulls accuracy towards 50% regardless of the writing.`);
  const thin = LENGTH_BUCKETS.filter((name) => blind.by_length[name].n > 0 && blind.by_length[name].n < 20);
  if (thin.length) lines.push(`Buckets with fewer than 20 items (${thin.join(", ")}) have wide intervals and should not be read on their own.`);
  return lines.join(" ");
}

export function renderVersion(entry) {
  const { aggregate: agg } = entry;
  const rows = RUBRIC_CRITERIA.map((key) => {
    const c = agg.rubric.criteria[key];
    const d = c.distribution;
    return `| ${key} | ${c.n} | ${c.na} | ${c.mean ?? "n/a"} | ${d[1]} / ${d[2]} / ${d[3]} / ${d[4]} / ${d[5]} |`;
  });
  const buckets = LENGTH_BUCKETS.map((name) => {
    const b = agg.blind.by_length[name];
    return `| ${name} | ${b.n} | ${b.correct} | ${pct(b.accuracy)} | ${interval(b.wilson95)} |`;
  });
  return [
    `### Card v${entry.card_version}`,
    "",
    `Generator \`${entry.gen_model}\`, judge \`${entry.judge_model}\`, seed \`${entry.seed}\`, card sha \`${entry.card_sha ?? "unrecorded"}\`, ${agg.n_items} test pairs. Tokens spent by the run that wrote this: ${entry.tokens_this_run.total} (cached calls cost nothing).`,
    "",
    `**Rubric judge** (${agg.rubric.scored} scored, ${agg.rubric.errors} errors):`,
    "",
    "| criterion | scored | na | mean | 1 / 2 / 3 / 4 / 5 |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    `**Blind test** (${agg.blind.scored} scored, ${agg.blind.errors} errors): the judge picked her real reply ${agg.blind.correct} of ${agg.blind.scored} times, accuracy **${pct(agg.blind.accuracy)}**, 95% Wilson interval ${interval(agg.blind.wilson95)}. Mean confidence ${agg.blind.mean_confidence ?? "n/a"}. The judge answered "A" ${pct(agg.blind.judge_answered_a_rate)} of the time; the bot was in position A ${pct(agg.blind.generated_in_a_rate)} of the time.`,
    "",
    "| her reply length | scored | correct | accuracy | 95% interval |",
    "|---|---|---|---|---|",
    ...buckets,
    "",
    `Reading: ${readingOf(agg.blind)}`,
  ].join("\n");
}

export function renderSection(persona) {
  const versions = Object.keys(persona.versions).sort((x, y) => Number(x) - Number(y));
  return [
    "## Persona (rubric judge and blind test)",
    "",
    "Run on the 125 **test** pairs, the split no other script reads. For each pair the generator writes a reply with the card as its system prompt. A Claude judge then (1) scores that reply 1 to 5 on voice, fact consistency and natural pitch, seeing the card summary and the fan comment but never her real reply, and (2) sees the fan comment and two unlabelled replies, hers and the bot's, in seeded random order, and says which is hers. Accuracy is the share of items where it picked hers; 50% means the two are indistinguishable. Prompts: [PERSONA-PROMPTS.md](PERSONA-PROMPTS.md) sections 6 and 7. Per-item records: `docs/evals/persona.json`. Results for different card versions or models are never pooled.",
    "",
    "Re-run: `npm run eval:persona -- --card-version <N> --gen-model <id> --judge-model <id>` (reads `.env.local`; interrupted runs resume from `data/persona/eval/cache/`).",
    "",
    ...versions.flatMap((v) => [renderVersion(persona.versions[v]), ""]),
  ].join("\n").trimEnd();
}

/** Replaces the text between the persona markers; everything outside them is left byte for byte. */
export function writeEvalsSection(path, section) {
  const text = readFileSync(path, "utf8");
  const block = `${MARKERS.start}\n${section}\n${MARKERS.end}`;
  const start = text.indexOf(MARKERS.start);
  const end = text.indexOf(MARKERS.end);
  let next;
  if (start !== -1 && end > start) next = text.slice(0, start) + block + text.slice(end + MARKERS.end.length);
  else next = `${text.replace(/\s*$/, "")}\n\n${block}\n`;
  writeFileSync(path, next);
}

/**
 * Flat summary of the newest card version for readers that want one number per criterion
 * (analytics): `rubric` is criterion to mean, `blindTest` the accuracy with its interval.
 */
export function summaryOf(persona) {
  const latest = Math.max(...Object.keys(persona.versions).map(Number));
  const { aggregate: agg } = persona.versions[String(latest)];
  const rubric = Object.fromEntries(Object.entries(agg.rubric.criteria).filter(([, c]) => c.mean !== null).map(([key, c]) => [key, c.mean]));
  const blind = agg.blind;
  return {
    summary_card_version: latest,
    rubric,
    blindTest: blind.accuracy === null ? {} : { accuracy: blind.accuracy, low: blind.wilson95.lower, high: blind.wilson95.upper, n: blind.scored },
  };
}

/** Folds one version's result into persona.json under its key and refreshes the EVALS.md section. */
export function recordResult({ result, personaPath, evalsPath }) {
  const persona = existsSync(personaPath) ? readJson(personaPath) : { versions: {} };
  persona.versions[String(result.card_version)] = result;
  Object.assign(persona, summaryOf(persona));
  writeJson(personaPath, persona);
  writeEvalsSection(evalsPath, renderSection(persona));
  return persona;
}

if (isMain(import.meta.url)) {
  loadEnvFile(".env.local");
  const args = parseArgs(process.argv.slice(2));
  for (const flag of ["gen-model", "judge-model"]) if (typeof args[flag] !== "string") throw new Error(`--${flag} <id> is required`);
  const data = args.data ?? "data/persona";
  const limit = args.limit ? Number(args.limit) : null;
  const result = await evalPersona({
    bankDir: join(data, "bank"),
    cardDir: join(data, "card"),
    cacheDir: join(data, "eval", "cache"),
    version: Number(args["card-version"] ?? 2),
    claude: createClaude(),
    genModel: args["gen-model"],
    judgeModel: args["judge-model"],
    seed: args.seed ?? "understudy-2026",
    budget: new TokenBudget(Number(args.budget ?? 2_000_000)),
    limit,
  });
  if (limit) console.log(`--limit ${limit}: nothing written`);
  else recordResult({ result, personaPath: "docs/evals/persona.json", evalsPath: "docs/EVALS.md" });
  console.log(JSON.stringify({ tokens: result.tokens_this_run, aggregate: result.aggregate }, null, 1));
}
