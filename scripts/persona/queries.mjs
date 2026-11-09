// eval/retrieval-queries.jsonl: a labelled query set for the retrieval eval.
//
// Claude writes fan questions from the chunk topics, told to avoid her wording, and names the
// chunks each question is grounded in. Each question then gets 40 candidates: the grounding
// chunks, the best lexical overlaps, and a seeded random fill, shuffled so position carries no
// signal. Claude labels which candidates are relevant. The grounding chunks are always in the
// candidate set because a question that avoids her wording is exactly the one lexical search
// misses, and a candidate set built from lexical hits alone would hide that.
import { join } from "node:path";
import { BudgetExceeded, isMain, loadEnvFile, parseArgs, readJsonl, seededRng, shuffled, TokenBudget, writeJson, writeJsonl } from "./lib/io.mjs";
import { createClaude } from "./lib/claude.mjs";
import { STOPWORDS } from "./style.mjs";

const CANDIDATES = 40;
const LEXICAL = 20;

export function parseJson(text) {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.search(/[[{]/);
  if (start === -1) throw new Error("no json in model output");
  return JSON.parse(stripped.slice(start));
}

export function words(text) {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 2 && !STOPWORDS.has(w)));
}

export function pickCandidates({ question, anchors, chunks, rng }) {
  const q = words(question);
  const scored = chunks
    .filter((c) => !anchors.includes(c.id))
    .map((c) => ({ id: c.id, score: [...words(c.text)].filter((w) => q.has(w)).length }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const chosen = new Set(anchors);
  for (const entry of scored) {
    if (chosen.size >= anchors.length + LEXICAL) break;
    if (entry.score > 0) chosen.add(entry.id);
  }
  const rest = shuffled(scored.filter((e) => !chosen.has(e.id)).map((e) => e.id), rng);
  for (const id of rest) {
    if (chosen.size >= CANDIDATES) break;
    chosen.add(id);
  }
  return shuffled([...chosen].sort(), rng);
}

export async function makeQueries({ bankDir, evalDir, claude, model, seed, budget, count = 30, concurrency = 4 }) {
  const chunks = readJsonl(join(bankDir, "chunks.jsonl"));
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const rng = seededRng(`${seed}:queries`);

  const captionChunks = chunks.filter((c) => c.source === "caption");
  const replyChunks = shuffled(chunks.filter((c) => c.source === "comment_reply"), rng).slice(0, 80);
  const listing = [...captionChunks, ...replyChunks].map((c) => `[${c.id}] ${c.text}`).join("\n");

  const ask = await claude.complete({
    model,
    maxTokens: 8000,
    prompt: `Below are chunks from one creator's retrieval bank: her post captions with image descriptions, and some fan-comment and reply pairs. A chat assistant answers fans in her voice and retrieves chunks to ground its answers.

First list the distinct topics the chunks cover. Then write exactly ${count} questions a fan could realistically send her in a chat, each on a different topic, each answerable from one to three of the chunks. Write them the way fans write: short, casual, not reusing her distinctive words (paraphrase, use synonyms, ask indirectly). For each question give the ids of the 1 to 3 chunks it is grounded in.

Output only JSON: {"topics": ["..."], "questions": [{"topic": "...", "question": "...", "source_chunk_ids": ["..."]}]}

=== CHUNKS ===
${listing}`,
  });
  budget.addClaude(ask.usage);
  const parsed = parseJson(ask.text);
  const questions = (parsed.questions ?? [])
    .filter((q) => typeof q.question === "string" && Array.isArray(q.source_chunk_ids))
    .map((q) => ({ topic: String(q.topic ?? ""), question: q.question.trim(), anchors: [...new Set(q.source_chunk_ids)].filter((id) => byId.has(id)) }))
    .filter((q) => q.question !== "" && q.anchors.length > 0)
    .slice(0, count);
  if (questions.length < count) throw new Error(`model returned ${questions.length} usable questions, expected ${count}`);

  const jobs = questions.map((q) => ({ ...q, candidates: pickCandidates({ question: q.question, anchors: q.anchors, chunks, rng }) }));
  const labelled = new Array(jobs.length);
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const i = next++;
      const job = jobs[i];
      try {
        const reply = await claude.complete({
          model,
          maxTokens: 1500,
          prompt: `A fan asks the creator: "${job.question}"

A chunk is relevant if it holds information that would help answer this question in her voice. Read each candidate and list the ids of the relevant ones. If none is relevant, list none.

Output only JSON: {"relevant": ["id", ...]}

=== CANDIDATES ===
${job.candidates.map((id) => `[${id}] ${byId.get(id).text}`).join("\n")}`,
        });
        budget.addClaude(reply.usage);
        const relevant = (parseJson(reply.text).relevant ?? []).filter((id) => job.candidates.includes(id));
        labelled[i] = { ok: true, relevant: [...new Set(relevant)].sort() };
      } catch (error) {
        if (error instanceof BudgetExceeded) throw error;
        labelled[i] = { ok: false, error: error?.code ?? error?.name ?? "unknown" };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const rows = [];
  let unlabelled = 0;
  let noRelevant = 0;
  jobs.forEach((job, i) => {
    if (!labelled[i].ok) return void unlabelled++;
    if (labelled[i].relevant.length === 0) return void noRelevant++;
    rows.push({
      id: `q${String(rows.length + 1).padStart(2, "0")}`,
      question: job.question,
      topic: job.topic,
      relevant: labelled[i].relevant,
      labeller_model: model,
    });
  });
  writeJsonl(join(evalDir, "retrieval-queries.jsonl"), rows);
  writeJson(join(evalDir, "retrieval-queries.meta.json"), {
    model,
    seed,
    topics: Array.isArray(parsed.topics) ? parsed.topics : [],
    counts: { asked: jobs.length, kept: rows.length, dropped_no_relevant: noRelevant, dropped_label_error: unlabelled },
    candidates_per_question: CANDIDATES,
    lexical_candidates: LEXICAL,
  });
  return rows;
}

if (isMain(import.meta.url)) {
  loadEnvFile(".env.local");
  const args = parseArgs(process.argv.slice(2));
  const model = args["query-model"] ?? args["card-model"];
  if (typeof model !== "string") throw new Error("--query-model <id> (or --card-model) is required");
  const data = args.data ?? "data/persona";
  const rows = await makeQueries({
    bankDir: join(data, "bank"),
    evalDir: join(data, "eval"),
    claude: createClaude(),
    model,
    seed: args.seed ?? "understudy-2026",
    budget: new TokenBudget(),
  });
  console.log(JSON.stringify({ queries: rows.length }));
}
