import { and, cosineDistance, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db/client";
import { simLines } from "@/db/schema";
import { seededRng } from "./random";

export interface LineHit {
  intent: string;
  text: string;
}

export interface RetrieveDeps {
  /** Embeds the query with Voyage (`input_type: query`); absent or failing means the tag fallback. */
  embedQuery?: (query: string) => Promise<number[]>;
  /** Seeds the fallback sample so a replayed run picks the same lines. */
  seed?: string;
  log?: (line: string) => void;
}

/**
 * The persona's own example lines nearest to the query (cosine over `sim_lines`). If Voyage fails, or none of the
 * persona's lines is embedded yet, the fallback is the lines of the wanted intent (all of them when `intent` is
 * missing or matches nothing), sampled with the seeded generator. The result only anchors tone; it never decides what is sent.
 */
export async function similarLines(persona: string, query: string, k: number, deps: RetrieveDeps = {}, intent?: string): Promise<LineHit[]> {
  if (deps.embedQuery) {
    try {
      const vec = await deps.embedQuery(query);
      const rows = await db
        .select({ intent: simLines.intent, text: simLines.text })
        .from(simLines)
        .where(and(eq(simLines.persona, persona), isNotNull(simLines.embedding)))
        .orderBy(cosineDistance(simLines.embedding, vec))
        .limit(k);
      if (rows.length > 0) return rows;
    } catch (e) {
      (deps.log ?? ((l) => console.error(l)))(`sim retrieval: voyage failed (${e instanceof Error ? e.name : "error"}), using tag sample`);
    }
  }
  const all = await db.select({ intent: simLines.intent, text: simLines.text }).from(simLines).where(eq(simLines.persona, persona)).orderBy(simLines.text);
  const tagged = intent ? all.filter((l) => l.intent === intent) : [];
  const pool = tagged.length > 0 ? tagged : all;
  const rng = seededRng(`lines:${deps.seed ?? "0"}:${persona}:${query}`);
  return pool
    .map((l) => ({ l, r: rng() }))
    .sort((a, b) => a.r - b.r)
    .slice(0, k)
    .map((x) => x.l);
}

