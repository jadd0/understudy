import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { config, creators, personaChunks } from "@/db/schema";
import { getConfig } from "@/lib/config";
import { retrieveFts, retrieveHybrid, retrieveVector, type Hit, type RetrieveDeps } from "@/lib/persona/retrieve";
import { embed } from "@/providers/voyage/embed";
import { UNBILLED_LIMITS } from "./load";

export const STRATEGIES = ["fts", "vector", "hybrid"] as const;
export type Strategy = (typeof STRATEGIES)[number];
export type Score = { recall: number; mrr: number; hit: number; ms: number };

/** Share of the labelled relevant chunks found in the top k. */
export function recallAtK(ranked: string[], relevant: string[], k: number): number {
  const top = new Set(ranked.slice(0, k));
  return relevant.filter((r) => top.has(r)).length / relevant.length;
}
/** Reciprocal rank of the first relevant chunk, 0 when none is returned. */
export function reciprocalRank(ranked: string[], relevant: string[]): number {
  const i = ranked.findIndex((r) => relevant.includes(r));
  return i < 0 ? 0 : 1 / (i + 1);
}
/** Highest recall@k, then highest MRR, then the cheaper strategy (fts < vector < hybrid). */
export function pickWinner(scores: Record<Strategy, Pick<Score, "recall" | "mrr">>): Strategy {
  const eq6 = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  return [...STRATEGIES].sort((x, y) => {
    if (!eq6(scores[x].recall, scores[y].recall)) return scores[y].recall - scores[x].recall;
    if (!eq6(scores[x].mrr, scores[y].mrr)) return scores[y].mrr - scores[x].mrr;
    return STRATEGIES.indexOf(x) - STRATEGIES.indexOf(y);
  })[0];
}

type Query = { id: string; question: string; relevant: string[] };

export function renderBlock(results: {
  k: number; queries: number; model: string; scores: Record<Strategy, Score>; winner: Strategy; chunks: number;
}): string {
  const f = (n: number, d = 3) => n.toFixed(d);
  const rows = STRATEGIES.map((s) => {
    const sc = results.scores[s];
    return `| ${s} | ${f(sc.recall)} | ${f(sc.mrr)} | ${f(sc.hit, 2)} | ${f(sc.ms, 1)} |`;
  });
  return [
    `Corpus: ${results.chunks} chunks, ${results.queries} labelled queries, k = ${results.k}, embedding model \`${results.model}\`.`,
    "",
    `| strategy | recall@${results.k} | MRR | hit@${results.k} | mean ms (db only) |`,
    "|---|---|---|---|---|",
    ...rows,
    "",
    `Winner by recall@${results.k} (ties: MRR, then the cheaper strategy): **${results.winner}**. Written to config \`retrieval.strategy\`.`,
  ].join("\n");
}

export function spliceBlock(doc: string, block: string): string {
  const start = "<!-- retrieval:start -->";
  const end = "<!-- retrieval:end -->";
  const a = doc.indexOf(start);
  const b = doc.indexOf(end);
  if (a < 0 || b < a) throw new Error("retrieval markers missing in docs/EVALS.md");
  return `${doc.slice(0, a + start.length)}\n${block}\n${doc.slice(b)}`;
}

async function main() {
  const handle = process.argv.includes("--creator") ? process.argv[process.argv.indexOf("--creator") + 1] : "junovale";
  console.log(`database host: ${new URL(process.env.DATABASE_URL ?? "").host}`);
  const [creator] = await db.select({ id: creators.id }).from(creators).where(eq(creators.handle, handle));
  if (!creator) throw new Error(`no creator ${handle}`);
  const model = await getConfig<string>("retrieval.voyage_model");
  const k = await getConfig<number>("retrieval.k");
  const queries = readFileSync("data/persona/eval/retrieval-queries.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Query);
  if (queries.length === 0) throw new Error("no queries");

  // All questions are embedded in one request up front; the real adapter, paced for the unbilled rate limit.
  const { embeddings, totalTokens } = await embed(queries.map((q) => q.question), "query", { model, ...UNBILLED_LIMITS });
  const byQuestion = new Map(queries.map((q, i) => [q.question, embeddings[i]]));
  const deps: RetrieveDeps = { db, embedQuery: async (q) => byQuestion.get(q)! };

  const run = { fts: retrieveFts, vector: retrieveVector, hybrid: retrieveHybrid } as const;
  const perQuery: Record<string, Record<Strategy, { ranked: string[]; recall: number; rr: number; ms: number }>> = {};
  for (const q of queries) {
    perQuery[q.id] = {} as never;
    for (const s of STRATEGIES) {
      const t0 = performance.now();
      const hits: Hit[] = await run[s](creator.id, q.question, k, deps);
      const ms = performance.now() - t0;
      const ranked = hits.map((h) => h.chunkId);
      perQuery[q.id][s] = { ranked, recall: recallAtK(ranked, q.relevant, k), rr: reciprocalRank(ranked, q.relevant), ms };
    }
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const scores = Object.fromEntries(
    STRATEGIES.map((s) => [
      s,
      {
        recall: mean(queries.map((q) => perQuery[q.id][s].recall)),
        mrr: mean(queries.map((q) => perQuery[q.id][s].rr)),
        hit: mean(queries.map((q) => (perQuery[q.id][s].recall > 0 ? 1 : 0))),
        ms: mean(queries.map((q) => perQuery[q.id][s].ms)),
      },
    ]),
  ) as Record<Strategy, Score>;
  const winner = pickWinner(scores);

  const chunks = await db.$count(personaChunks, eq(personaChunks.creatorId, creator.id));
  const results = { model, k, queries: queries.length, chunks, queryTokens: totalTokens, scores, winner, perQuery };
  mkdirSync("data/persona/eval", { recursive: true });
  writeFileSync("data/persona/eval/retrieval-results.json", JSON.stringify(results, null, 2) + "\n");
  const block = renderBlock(results);
  const docPath = path.resolve("docs/EVALS.md");
  writeFileSync(docPath, spliceBlock(readFileSync(docPath, "utf8"), block));
  await db.update(config).set({ value: winner, updatedAt: new Date() }).where(and(eq(config.key, "retrieval.strategy"), isNull(config.creatorId)));
  console.log(block);
  console.log(`query embedding tokens: ${totalTokens}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("eval:retrieval failed:", (e as { code?: string; name?: string }).code ?? (e as Error).name);
      process.exit(1);
    });
}
