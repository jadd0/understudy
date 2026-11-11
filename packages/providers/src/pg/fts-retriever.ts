import { retrieveFts, type Chunk, type EngineDb, type Retriever } from "@jadd0/understudy-engine";

/** The engine's default retriever: the Postgres full-text strategy of `retrieve` in the engine package, behind the retriever port. */
export class FtsRetriever implements Retriever {
  constructor(private readonly db: EngineDb) {}

  async retrieve(creatorId: string, query: string, k: number): Promise<readonly Chunk[]> {
    const hits = await retrieveFts(creatorId, query, k, {
      db: this.db,
      embedQuery: async () => {
        throw new Error("the full-text strategy embeds nothing");
      },
    });
    return hits.map((h) => ({ id: h.chunkId, text: h.text }));
  }
}
