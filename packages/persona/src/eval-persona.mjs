// Persona evals on the TEST split, which nothing else reads: for each of her held-out reply pairs,
// Claude (--gen-model) writes a reply through a drafter: the app's eval script passes the engine's own
// prompt path (card, retrieved train lines, this reply's style draw, then the draw's edge clean-up); on
// its own this file drafts from the card alone. Then Claude (--judge-model)
//   1. scores that reply 1-5 on voice, fact consistency and natural pitch (rubric judge), and
//   2. is shown her real reply and the generated one, unlabelled, once in each order, and says
//      which one is hers (blind test). Accuracy is over all judgements; position bias is reported.
// Per-marker rates (sign-off x, mate, ...) are reported for her real replies and the bot's.
// Results go to docs/quality/evals/persona.json and between the persona markers of docs/quality/EVALS.md.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BudgetExceeded, isMain, loadEnvFile, parseArgs, readJson, readJsonl, sha16, stableSort, TokenBudget, writeJson } from "./lib/io.mjs";
import { createClaude } from "./lib/claude.mjs";
import { histogram, lengthBucket, LENGTH_BUCKETS, mean, wilson } from "./lib/stats.mjs";
import { capitalise } from "./draft-card.mjs";
import { measureMarkers, petFromProfile } from "./style.mjs";
import { cardSummary, cleanReply } from "./rapid-eval.mjs";

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

const STOP = new Set("a an and are as at be but by for from get got had has have he her him his how i i'm if in is it it's its me my no not of on or our she so that the their them they this to up was we were what when where who why with you your you're".split(" "));
const words = (text) => (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w));

/** Chunks the engine may retrieve for her: nothing from the validation or test splits. */
export function trainChunks(bankDir) {
  return readJsonl(join(bankDir, "chunks.jsonl")).filter((c) => c.split !== "test" && c.split !== "validation");
}

/**
 * The k chunks sharing the most (inverse-frequency weighted) words with the query, ties by id. A lexical stand-in for
 * the engine's retriever so the eval needs neither a database nor embeddings.
 */
export function retrieveChunks(chunks, query, k = 5) {
  const docs = chunks.map((c) => ({ c, set: new Set(words(c.text)) }));
  const df = new Map();
  for (const d of docs) for (const w of d.set) df.set(w, (df.get(w) ?? 0) + 1);
  const q = [...new Set(words(query))];
  return docs
    .map((d) => ({ c: d.c, score: q.reduce((sum, w) => sum + (d.set.has(w) ? Math.log(1 + docs.length / df.get(w)) : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score || (x.c.id < y.c.id ? -1 : 1))
    .slice(0, k)
    .map((x) => ({ id: x.c.id, text: x.c.text }));
}

/**
 * The drafter used when the caller brings no other: the card alone as the system prompt, no retrieval and no style
 * draw. The engine path (prompt builder, retrieval, draw, edge clean-up) is built by the app's eval script, which
 * passes its own drafter; this package takes no dependency on the engine.
 */
export const cardDrafter = Object.assign(
  async ({ pair, card }) => ({
    system: card,
    prompt: `A fan commented on your Instagram post:\n\n"${pair.replying_to}"\n\nWrite your reply. Output only the reply text, nothing else.`,
    draw: null,
    finish: (text) => text,
  }),
  { label: "card alone as the system prompt, no retrieval, no style draw" },
);

/** The retry-once wrapper: an item with any error is run again; the cache replays what already succeeded. */
const hasError = (item) => Boolean(item.rubric_error || item.blind_error);

export async function evaluateItem({ pair, card, summary, claude, genModel, judgeModel, budget, personaName, cached, drafter }) {
  const real = cleanReply(pair.text);
  const base = {
    id: pair.id,
    post_shortcode: pair.post_shortcode,
    fan_comment: pair.replying_to,
    real,
    length_bucket: lengthBucket(real),
    generated: null,
    draw: null,
    rubric: null,
    rubric_error: null,
    blind: null,
    blind_error: null,
  };
  let generated;
  let draw = null;
  try {
    const prepared = await drafter({ pair, card });
    draw = prepared.draw ?? null;
    generated = await cached({ stage: "gen", model: genModel, thinking: "off", request: sha16(`${prepared.system}\n${prepared.prompt}`), draw }, async () => {
      const gen = await claude.complete({ model: genModel, system: prepared.system, prompt: prepared.prompt, maxTokens: 300 });
      budget.addClaude(gen.usage);
      return prepared.finish(cleanReply(gen.text));
    });
    if (real === "" || generated === "") throw new JudgeOutputError("empty_reply");
  } catch (error) {
    if (error instanceof BudgetExceeded) throw error;
    return { ...base, generated: generated ?? null, draw, rubric_error: errorCode(error), blind_error: errorCode(error) };
  }

  const judge = async (stage, system, prompt, parse) => {
    const verdict = await cached({ stage, model: judgeModel, thinking: "off", system, prompt }, async () => {
      const response = await claude.complete({ model: judgeModel, system, prompt, maxTokens: 400 });
      budget.addClaude(response.usage);
      return parse(response.text);
    });
    return verdict;
  };

  // Both orders for every pair: the bot is A once and B once, so a judge that favours a position cancels out.
  const orders = ["a", "b"];
  const [rubric, ...blinds] = await Promise.allSettled([
    judge("rubric", rubricSystem(personaName), rubricPrompt({ summary, comment: pair.replying_to, reply: generated }), parseRubric),
    ...orders.map((generatedSide) => {
      const [a, b] = generatedSide === "a" ? [generated, real] : [real, generated];
      return judge("blind", blindSystem(personaName), blindPrompt({ comment: pair.replying_to, a, b }), parseBlind);
    }),
  ]);
  for (const outcome of [rubric, ...blinds]) if (outcome.status === "rejected" && outcome.reason instanceof BudgetExceeded) throw outcome.reason;

  const item = { ...base, generated, draw };
  if (rubric.status === "fulfilled") item.rubric = rubric.value;
  else item.rubric_error = errorCode(rubric.reason);
  const failed = blinds.find((o) => o.status === "rejected");
  if (failed) item.blind_error = errorCode(failed.reason);
  else {
    item.blind = blinds.map((o, i) => {
      const generatedSide = orders[i];
      const realSide = generatedSide === "a" ? "B" : "A";
      return { generated_side: generatedSide, choice: o.value.author, confidence: o.value.confidence, reason: o.value.reason, correct: o.value.author === realSide };
    });
  }
  return item;
}

const rate4 = (n, d) => (d ? Math.round((n / d) * 10000) / 10000 : null);

const accuracyOf = (judgements) => {
  const correct = judgements.filter((j) => j.correct).length;
  return { n: judgements.length, correct, accuracy: rate4(correct, judgements.length), wilson95: wilson(correct, judgements.length) };
};

const MARKER_KEYS = ["signoff_x", "mate", "babe", "pet_name", "emoji", "concrete_fact"];

/** Marker rates for her real replies and the bot's on the same items, and her train rates if given. */
function markerTable(items, { pet = null, train = null } = {}) {
  const both = items.filter((i) => i.generated);
  if (both.length === 0) return null;
  const real = measureMarkers(both.map((i) => i.real), pet);
  const bot = measureMarkers(both.map((i) => i.generated), pet);
  return {
    n: both.length,
    rates: Object.fromEntries(MARKER_KEYS.map((k) => [k, { train: train?.[k] ?? null, real: real[k], bot: bot[k] }])),
  };
}

export function aggregate(items, markerOptions = {}) {
  // One judgement per order per pair; `blind` is null on an item whose judge call failed.
  const judgements = items.flatMap((i) => (i.blind ?? []).map((b) => ({ ...b, length_bucket: i.length_bucket })));
  const rubricItems = items.filter((i) => i.rubric);
  const rubric = {};
  for (const key of RUBRIC_CRITERIA) {
    const scores = rubricItems.map((i) => i.rubric[key].score).filter((s) => s !== "na");
    rubric[key] = { n: scores.length, na: rubricItems.length - scores.length, mean: mean(scores), distribution: histogram(scores) };
  }
  const bucketOf = (name) => accuracyOf(judgements.filter((j) => j.length_bucket === name));
  const answeredA = judgements.filter((j) => j.choice === "A").length;
  const inA = judgements.filter((j) => j.generated_side === "a");
  const inB = judgements.filter((j) => j.generated_side === "b");
  return {
    n_items: items.length,
    rubric: { scored: rubricItems.length, errors: items.length - rubricItems.length, criteria: rubric },
    blind: {
      scored: judgements.length,
      errors: items.filter((i) => !i.blind).length,
      ...accuracyOf(judgements),
      judge_answered_a_rate: rate4(answeredA, judgements.length),
      generated_in_a_rate: rate4(inA.length, judgements.length),
      // Accuracy with the bot in A against with the bot in B: a gap is a position bias in the judge.
      by_position: { generated_in_a: accuracyOf(inA), generated_in_b: accuracyOf(inB) },
      mean_confidence: mean(judgements.map((j) => j.confidence)),
      by_length: Object.fromEntries(LENGTH_BUCKETS.map((name) => [name, bucketOf(name)])),
    },
    markers: markerTable(items, markerOptions),
  };
}

export async function evalPersona({ bankDir, cardDir, cacheDir, version, claude, genModel, judgeModel, seed, budget, personaName, concurrency = 4, limit = null, drafter = cardDrafter }) {
  const card = readFileSync(join(cardDir, `v${version}.md`), "utf8");
  const splits = readJson(join(bankDir, "splits.json"));
  const profile = readJson(join(bankDir, "profile.json"));
  const name = personaName ?? capitalise(profile.display_name);
  const testIds = new Set(splits.replies.test);
  let pairs = stableSort(readJsonl(join(bankDir, "replies.jsonl")).filter((r) => testIds.has(r.id)), (r) => r.id);
  if (pairs.length === 0) throw new Error("no test pairs");

  const styleFile = join(bankDir, "style.json");
  const markers = existsSync(styleFile) ? readJson(styleFile).markers ?? null : null;
  const pet = markers?.pet ?? petFromProfile(profile);
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
      const args = { pair: pairs[i], card, summary, claude, genModel, judgeModel, budget, personaName: name, cached, drafter };
      items[i] = await evaluateItem(args);
      // An errored item is tried once more; the cache replays what already succeeded, so only the failure is paid for.
      if (hasError(items[i])) items[i] = await evaluateItem(args);
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
    drafter: drafter.label ?? "custom",
    tokens_this_run: { total: budget.used, claude_input: budget.claudeInput, claude_output: budget.claudeOutput, calls: budget.calls },
    aggregate: aggregate(items, { pet, train: markers }),
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

const MARKER_LABELS = { signoff_x: 'sign-off "x"', mate: '"mate"', babe: '"babe"', pet_name: "pet's name", emoji: "emoji", concrete_fact: "concrete fact (price or place)" };

/** The per-marker table: her train rate, her real test replies, the bot's. Empty when the run recorded none. */
function markerRows(markers) {
  if (!markers) return [];
  return [
    "",
    `**Voice markers** (share of replies using each, over the ${markers.n} pairs with a generated reply):`,
    "",
    "| marker | her train replies | her test replies | the bot |",
    "|---|---|---|---|",
    ...Object.entries(markers.rates).map(([key, r]) => `| ${MARKER_LABELS[key] ?? key} | ${pct(r.train)} | ${pct(r.real)} | ${pct(r.bot)} |`),
  ];
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
    `Generator \`${entry.gen_model}\`, judge \`${entry.judge_model}\`, seed \`${entry.seed}\`, drafter ${entry.drafter ?? "card alone"}, card sha \`${entry.card_sha ?? "unrecorded"}\`, ${agg.n_items} test pairs. Tokens spent by the run that wrote this: ${entry.tokens_this_run.total} (cached calls cost nothing).`,
    "",
    `**Rubric judge** (${agg.rubric.scored} scored, ${agg.rubric.errors} errors):`,
    "",
    "| criterion | scored | na | mean | 1 / 2 / 3 / 4 / 5 |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    `**Blind test** (${agg.blind.scored} ${agg.blind.by_position ? "judgements" : "scored"}, ${agg.blind.errors} ${agg.blind.by_position ? "pairs with an error" : "errors"}): the judge picked her real reply ${agg.blind.correct} of ${agg.blind.scored} times, accuracy **${pct(agg.blind.accuracy)}**, 95% Wilson interval ${interval(agg.blind.wilson95)}. Mean confidence ${agg.blind.mean_confidence ?? "n/a"}. The judge answered "A" ${pct(agg.blind.judge_answered_a_rate)} of the time; the bot was in position A ${pct(agg.blind.generated_in_a_rate)} of the time.${agg.blind.by_position ? ` Accuracy with the bot in A: ${pct(agg.blind.by_position.generated_in_a.accuracy)}; with the bot in B: ${pct(agg.blind.by_position.generated_in_b.accuracy)}.` : ""}`,
    "",
    "| her reply length | scored | correct | accuracy | 95% interval |",
    "|---|---|---|---|---|",
    ...buckets,
    "",
    `Reading: ${readingOf(agg.blind)}`,
    ...(agg.markers ? markerRows(agg.markers) : ["", "_This run predates the style draw and the both-order judging: the bot was written from the card alone and each pair was judged once. The next run replaces it._"]),
  ].join("\n");
}

export function renderSection(persona) {
  const versions = Object.keys(persona.versions).sort((x, y) => Number(x) - Number(y));
  return [
    "## Persona (rubric judge and blind test)",
    "",
    "Run on the **test** pairs, the split no other script reads. For each pair the generator writes a reply through a drafter, recorded with each run. The repository's script (`npm run eval:persona`) uses the engine's own prompt path: the card, lines retrieved from her train replies and captions, this reply's style draw (which of her voice markers it may use, drawn at her measured train rates with a seeded generator) and the engine's edge clean-up. A Claude judge then (1) scores that reply 1 to 5 on voice, fact consistency and natural pitch, seeing the card summary and the fan comment but never her real reply, and (2) sees the fan comment and two unlabelled replies, hers and the bot's, once in each order, and says which is hers. Accuracy is the share of all judgements that picked hers; 50% means the two are indistinguishable, and the split by the bot's position shows any position bias. An item that errors is tried once more. The per-marker table compares how often her real replies and the bot's use each marker. Prompts: [PERSONA-PROMPTS.md](../persona/PERSONA-PROMPTS.md) sections 6 and 7. Per-item records: `docs/quality/evals/persona.json`. Results for different card versions or models are never pooled.",
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
  else recordResult({ result, personaPath: "docs/quality/evals/persona.json", evalsPath: "docs/quality/EVALS.md" });
  console.log(JSON.stringify({ tokens: result.tokens_this_run, aggregate: result.aggregate }, null, 1));
}
