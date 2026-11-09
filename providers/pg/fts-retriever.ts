import type { Db } from "@/db/client";
import { retrieveFts } from "@/lib/persona/retrieve";
import type { Chunk, Retriever } from "@/platform/ports/retriever";

/** The engine's default retriever: the Postgres full-text strategy of `lib/persona/retrieve`, behind the retriever port. */
export class FtsRetriever implements Retriever {
  constructor(private readonly db: Db) {}

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
