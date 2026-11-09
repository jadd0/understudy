import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { creators, personaChunks } from "@/db/schema";
import { ftsQuery, retrieveFts, retrieveHybrid, retrieveVector, type RetrieveDeps } from "@/lib/persona/retrieve";
import { makeUser } from "@/db/test-helpers";

const hot = (n: number) => Array.from({ length: 1024 }, (_, i) => (i === n ? 1 : 0));
const tag = randomUUID().slice(0, 8);
let a = "";
let b = "";
// Query text -> vector; chunk vectors are one-hot so cosine ranking is exact.
const QV: Record<string, number> = { "vec-only": 0 };
const deps: RetrieveDeps = { db, embedQuery: async (q) => hot(QV[q] ?? 999) };

async function mkCreator() {
  const u = await makeUser({ role: "creator" });
  const [c] = await db.insert(creators).values({ userId: u.id, handle: `h-${randomUUID()}`, displayName: "C" }).returning();
  return c.id;
}
const chunk = (creatorId: string, id: string, text: string, v: number | null) => ({
  creatorId,
  source: "caption" as const,
  text,
  meta: { chunk_id: id },
  embedding: v === null ? null : hot(v),
});

beforeAll(async () => {
  a = await mkCreator();
  b = await mkCreator();
  await db.insert(personaChunks).values([
    chunk(a, "c0", "sunrise over the lake", 0),
    chunk(a, "c1", `zebra${tag} stripes at the zoo`, null),
    chunk(a, "c2", "nothing relevant here", 2),
    chunk(a, "c3", `zebra${tag} and sunrise together`, 3),
    chunk(b, "other", `zebra${tag} belongs to another creator`, 0),
  ]);
});

describe("retrieval", () => {
  test("ftsQuery drops stopwords and keeps terms", () => {
    expect(ftsQuery("what is the zebra")).toBe("zebra");
    expect(ftsQuery("the of a")).toBeNull();
  });

  test("fts finds the lexical match and never another creator's chunk", async () => {
    const hits = await retrieveFts(a, `zebra${tag}`, 5, deps);
    expect(hits.map((h) => h.chunkId).sort()).toEqual(["c1", "c3"]);
    expect(await retrieveFts(a, "the of a", 5, deps)).toEqual([]);
  });

  test("vector top-1 is the nearest one-hot chunk, scoped to the creator", async () => {
    const hits = await retrieveVector(a, "vec-only", 5, deps);
    expect(hits[0].chunkId).toBe("c0");
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => h.chunkId)).not.toContain("other");
  });

  test("hybrid fuses both lists: the chunk in both outranks one in either", async () => {
    // fts matches c1 and c3; the vector query points at c3. c3 is in both lists.
    const hits = await retrieveHybrid(a, `zebra${tag}`, 5, {
      db,
      embedQuery: async () => hot(3),
    });
    expect(hits[0].chunkId).toBe("c3");
    expect(hits.map((h) => h.chunkId)).toContain("c1");
    expect(hits.map((h) => h.chunkId)).not.toContain("other");
    const solo = hits.find((h) => h.chunkId === "c1")!;
    expect(hits[0].score).toBeGreaterThan(solo.score);
  });
});
