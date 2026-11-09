import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { personaChunks } from "@/db/schema";
import { makeCreator } from "@/lib/engine/test-db";
import { FtsRetriever } from "./fts-retriever";

describe("FtsRetriever", () => {
  test("returns the creator's matching chunks only, best first, at most k", async () => {
    const a = await makeCreator();
    const b = await makeCreator();
    await db.insert(personaChunks).values([
      { creatorId: a.id, source: "caption", text: "i adopted a cat named miso", meta: { chunk_id: "c1" } },
      { creatorId: a.id, source: "caption", text: "cat cat cat cosplay as a cat", meta: { chunk_id: "c2" } },
      { creatorId: a.id, source: "caption", text: "tokyo trip photos", meta: { chunk_id: "c3" } },
      { creatorId: b.id, source: "caption", text: "someone else's cat", meta: { chunk_id: "c4" } },
    ]);
    const r = new FtsRetriever(db);
    const hits = await r.retrieve(a.id, "do you like cats or a cat?", 5);
    expect(hits.map((h) => h.id).sort()).toEqual(["c1", "c2"]);
    expect(await r.retrieve(a.id, "cat", 1)).toHaveLength(1);
    expect(await r.retrieve(a.id, "zzzzqq", 5)).toEqual([]);
    expect(await r.retrieve(a.id, "?? !!", 5)).toEqual([]);
  });
});
