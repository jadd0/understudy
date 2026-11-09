import { sql } from "drizzle-orm";
import type { EngineDb } from "./ports/db";

export type Hit = { chunkId: string; text: string; score: number };
export type RetrieveDeps = {
  db: Pick<EngineDb, "execute">;
  /** Embeds one query string (Voyage input_type "query"). Only the vector and hybrid strategies call it. */
  embedQuery: (query: string) => Promise<number[]>;
};

export const HYBRID_POOL = 20;
export const RRF_K = 60;

// The 'simple' text-search configuration has no stopword list and ts_rank_cd has no IDF, so
// function words would match nearly every chunk. These are dropped from the query side only.
const STOP = new Set(
  "a an and are as at be but by do does did for from had has have how i if in is it its me my of on or so than that the their them then there they this to u ur was were what when where which who why will with would you your".split(" "),
);

/** Alphanumeric terms OR-ed together; null when nothing searchable is left. */
export function ftsQuery(query: string): string | null {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].filter((t) => !STOP.has(t));
  return terms.length ? terms.join(" | ") : null;
}

const toHits = (rows: { rows: Record<string, unknown>[] }): Hit[] =>
  rows.rows.map((r) => ({ chunkId: String(r.chunk_id), text: String(r.text), score: Number(r.score) }));

// meta.chunk_id is the bank's stable id (cap_..., rep_...); it is what the labelled queries refer to.
export async function retrieveFts(creatorId: string, query: string, k: number, deps: RetrieveDeps): Promise<Hit[]> {
  const q = ftsQuery(query);
  if (!q) return [];
  const res = await deps.db.execute(sql`
    select meta->>'chunk_id' as chunk_id, text, ts_rank_cd(tsv, to_tsquery('simple', ${q})) as score
    from persona_chunks
    where creator_id = ${creatorId} and tsv @@ to_tsquery('simple', ${q})
    order by score desc, id
    limit ${k}`);
  return toHits(res);
}

export async function retrieveVector(creatorId: string, query: string, k: number, deps: RetrieveDeps): Promise<Hit[]> {
  const v = `[${(await deps.embedQuery(query)).join(",")}]`;
  const res = await deps.db.execute(sql`
    select meta->>'chunk_id' as chunk_id, text, 1 - (embedding <=> ${v}::vector) as score
    from persona_chunks
    where creator_id = ${creatorId} and embedding is not null
    order by embedding <=> ${v}::vector, id
    limit ${k}`);
  return toHits(res);
}

/** Reciprocal rank fusion (k = 60) over the top 20 of the full-text and vector lists. */
export async function retrieveHybrid(creatorId: string, query: string, k: number, deps: RetrieveDeps): Promise<Hit[]> {
  const [a, b] = await Promise.all([
    retrieveFts(creatorId, query, HYBRID_POOL, deps),
    retrieveVector(creatorId, query, HYBRID_POOL, deps),
  ]);
  const fused = new Map<string, Hit>();
  for (const list of [a, b]) {
    list.forEach((h, i) => {
      const cur = fused.get(h.chunkId);
      const add = 1 / (RRF_K + i + 1);
      fused.set(h.chunkId, { ...h, score: (cur?.score ?? 0) + add });
    });
  }
  return [...fused.values()].sort((x, y) => y.score - x.score || x.chunkId.localeCompare(y.chunkId)).slice(0, k);
}
