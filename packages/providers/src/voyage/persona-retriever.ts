import { retrieveFts, retrieveHybrid, retrieveVector, type Hit, type RetrieveDeps, type Chunk, type EngineDb, type Retriever } from "@jadd0/understudy-engine";

/**
 * Reply chunks read "fan: <comment> / juno: @user <reply>": Instagram puts the @mention in front of every comment
 * reply. A DM never starts with one, and showing the model a page of "@user ..." replies teaches it to open with
 * one, so the mention is removed before a chunk reaches the prompt. The stored and embedded text is
 * unchanged, so nothing has to be re-embedded.
 */
export function promptText(text: string): string {
  return text.replace(/( \/ [^:]{1,40}: )(?:@\S+\s*)+/, "$1");
}

export type RetrievalStrategy = "fts" | "vector" | "hybrid";

export function parseStrategy(value: unknown): RetrievalStrategy {
  if (value === "fts" || value === "vector" || value === "hybrid") return value;
  throw new Error(`retrieval.strategy must be fts, vector or hybrid (got ${JSON.stringify(value)})`);
}

/**
 * The engine's retriever: the strategy chosen by the retrieval eval (`retrieval.strategy`) over
 * `persona_chunks`. Vector and hybrid embed the fan's message with Voyage (`input_type: query`). If that call
 * fails, the turn still gets chunks from Postgres full-text search rather than none: retrieval only adds facts
 * and tone, so a weaker list beats an empty one, and the fallback is logged.
 */
export class PersonaRetriever implements Retriever {
  constructor(
    private readonly db: EngineDb,
    private readonly strategy: RetrievalStrategy,
    private readonly embedQuery: RetrieveDeps["embedQuery"],
    private readonly log: (line: string) => void = (l) => console.error(l),
  ) {}

  async retrieve(creatorId: string, query: string, k: number): Promise<readonly Chunk[]> {
    const deps: RetrieveDeps = { db: this.db, embedQuery: this.embedQuery };
    let hits: Hit[];
    if (this.strategy === "fts") {
      hits = await retrieveFts(creatorId, query, k, deps);
    } else {
      try {
        hits = await (this.strategy === "vector" ? retrieveVector : retrieveHybrid)(creatorId, query, k, deps);
      } catch (e) {
        this.log(`retrieval: ${this.strategy} failed (${e instanceof Error ? e.name : "error"}), falling back to fts`);
        hits = await retrieveFts(creatorId, query, k, deps);
      }
    }
    return hits.map((h) => ({ id: h.chunkId, text: promptText(h.text) }));
  }
}
