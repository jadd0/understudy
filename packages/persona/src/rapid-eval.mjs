// Jev rapid eval on the VALIDATION split: Claude writes a reply to each fan comment with the
// card as its system prompt, then Jev is asked which of the two replies she wrote herself.
// Score = share of scored items where Jev picks the generated reply or is at most 0.6 confident.
// Items where a call fails or Jev answers outside its criteria are counted as errors, never scored.
import { join } from "node:path";
import { BudgetExceeded, isMain, loadEnvFile, parseArgs, readJson, readJsonl, seededRng, TokenBudget, writeJson } from "./lib/io.mjs";
import { createClaude } from "./lib/claude.mjs";
import { createJev } from "./lib/jev.mjs";
import { capitalise } from "./draft-card.mjs";
import { readFileSync } from "node:fs";

export const INDISTINGUISHABLE_AT = 0.6;

/** Real replies start with the @handle of the person addressed; the generated one does not. */
export function stripLeadingMentions(text) {
  return text.replace(/^(?:\s*@\S+)+\s*/, "").trim();
}

export function classify({ choice, confidence, generatedSide }) {
  return choice === generatedSide || confidence <= INDISTINGUISHABLE_AT ? "indistinguishable" : "detected";
}

export function cardSummary(card) {
  const sections = new Map(card.split(/^## /m).slice(1).map((part) => [part.split("\n", 1)[0].trim(), part]));
  return ["Identity", "Voice rules"]
    .filter((heading) => sections.has(heading))
    .map((heading) => `${sections.get(heading).trim()}`)
    .join("\n\n")
    .slice(0, 3500);
}

/** Surrounding quotes and a leading @handle are not part of a reply; the generator sometimes adds them. */
export function cleanReply(text) {
  return stripLeadingMentions(text.trim().replace(/^["“]|["”]$/g, ""));
}

/** One reply as the persona: the card is the system prompt. Shared by the rapid eval and the persona eval. */
export async function generateReply({ claude, model, card, comment, budget }) {
  const gen = await claude.complete({
    model,
    system: card,
    prompt: `A fan commented on your Instagram post:\n\n"${comment}"\n\nWrite your reply. Output only the reply text, nothing else.`,
    maxTokens: 300,
  });
  budget.addClaude(gen.usage);
  return cleanReply(gen.text);
}

export async function evaluateItem({ pair, generatedSide, card, summary, claude, jev, genModel, jevModel, budget, personaName }) {
  const real = stripLeadingMentions(pair.text);
  const base = { id: pair.id, post_shortcode: pair.post_shortcode, fan_comment: pair.replying_to, real, generated_side: generatedSide };
  try {
    const generated = await generateReply({ claude, model: genModel, card, comment: pair.replying_to, budget });
    if (real === "" || generated === "") return { ...base, generated, outcome: "error", error: "empty_reply" };

    const [a, b] = generatedSide === "a" ? [generated, real] : [real, generated];
    const verdict = await jev.ask({
      model: jevModel,
      state: { card_summary: summary, fan_comment: pair.replying_to, reply_a: a, reply_b: b },
      questions: [
        {
          key: "author",
          prompt: `Which reply did ${personaName} write herself? One of the two replies was written by ${personaName}; the other was written by an AI imitating her.`,
          options: [
            { key: "a", label: `Reply A was written by ${personaName}` },
            { key: "b", label: `Reply B was written by ${personaName}` },
          ],
        },
      ],
    });
    budget.addJev(verdict.usage);
    const answer = verdict.answers[0];
    // Jev answers with the side it believes is hers; picking the generated side is a miss for the judge.
    return {
      ...base,
      generated,
      choice: answer.value,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      jev_model: verdict.model,
      outcome: classify({ choice: answer.value, confidence: answer.confidence, generatedSide }),
    };
  } catch (error) {
    if (error instanceof BudgetExceeded) throw error;
    return { ...base, outcome: "error", error: error?.code ?? error?.name ?? "unknown" };
  }
}

export function aggregate(items) {
  const scored = items.filter((i) => i.outcome !== "error");
  const indistinguishable = scored.filter((i) => i.outcome === "indistinguishable").length;
  const round = (n) => Math.round(n * 10000) / 10000;
  return {
    n_items: items.length,
    errors: items.length - scored.length,
    scored: scored.length,
    indistinguishable,
    detected: scored.length - indistinguishable,
    score: scored.length ? round(indistinguishable / scored.length) : null,
    picked_generated_rate: scored.length ? round(scored.filter((i) => i.choice === i.generated_side).length / scored.length) : null,
    mean_confidence: scored.length ? round(scored.reduce((n, i) => n + i.confidence, 0) / scored.length) : null,
    indistinguishable_at_confidence: INDISTINGUISHABLE_AT,
  };
}

export async function rapidEval({ bankDir, cardDir, version, claude, jev, genModel, jevModel, seed, budget, personaName, concurrency = 4 }) {
  const card = readFileSync(join(cardDir, `v${version}.md`), "utf8");
  const splits = readJson(join(bankDir, "splits.json"));
  const profile = readJson(join(bankDir, "profile.json"));
  const name = personaName ?? capitalise(profile.display_name);
  const validation = new Set(splits.replies.validation);
  const pairs = readJsonl(join(bankDir, "replies.jsonl")).filter((r) => validation.has(r.id));
  if (pairs.length === 0) throw new Error("no validation pairs");

  // Sides are drawn up front, in id order, so they do not depend on call timing.
  const rng = seededRng(`${seed}:rapid-eval`);
  const sides = pairs.map(() => (rng() < 0.5 ? "a" : "b"));
  const summary = cardSummary(card);

  const items = new Array(pairs.length);
  let next = 0;
  async function worker() {
    while (next < pairs.length) {
      const i = next++;
      items[i] = await evaluateItem({ pair: pairs[i], generatedSide: sides[i], card, summary, claude, jev, genModel, jevModel, budget, personaName: name });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const result = {
    card_version: version,
    gen_model: genModel,
    jev_model: jevModel,
    jev_resolved_model: items.find((i) => i.jev_model)?.jev_model ?? null,
    seed,
    aggregate: aggregate(items),
    items,
  };
  writeJson(join(cardDir, `v${version}.eval.json`), result);
  return result;
}

if (isMain(import.meta.url)) {
  loadEnvFile(".env.local");
  const args = parseArgs(process.argv.slice(2));
  for (const flag of ["gen-model", "jev-model"]) if (typeof args[flag] !== "string") throw new Error(`--${flag} <id> is required`);
  const data = args.data ?? "data/persona";
  const result = await rapidEval({
    bankDir: join(data, "bank"),
    cardDir: join(data, "card"),
    version: Number(args["card-version"] ?? 1),
    claude: createClaude(),
    jev: createJev(),
    genModel: args["gen-model"],
    jevModel: args["jev-model"],
    seed: args.seed ?? "understudy-2026",
    budget: new TokenBudget(),
  });
  console.log(JSON.stringify(result.aggregate));
}
