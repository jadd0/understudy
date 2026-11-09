import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { creators, personaCards } from "@/db/schema";
import { makeUser } from "@/db/test-helpers";
import { latestCardVersion } from "@/scripts/persona/load";
import { publishCard } from "@/scripts/persona/publish-card";

async function creator() {
  const u = await makeUser({ role: "creator" });
  const [c] = await db.insert(creators).values({ userId: u.id, handle: `c${randomUUID().slice(0, 8)}`, displayName: "C" }).returning();
  return c;
}
const cards = (id: string) =>
  db.select().from(personaCards).where(eq(personaCards.creatorId, id)).orderBy(asc(personaCards.version));
const BODY = "## Never\n- Never meet up.\n";

describe("publishCard", () => {
  test("a new body becomes the next version, published, with its never-list", async () => {
    const c = await creator();
    await db.insert(personaCards).values({ creatorId: c.id, version: 1, body: "old", neverList: [] });
    expect(await publishCard(c.id, BODY)).toEqual({ version: 2, inserted: true, alreadyPublished: false });
    const rows = await cards(c.id);
    expect(rows[1]).toMatchObject({ version: 2, body: BODY, neverList: ["meet up"] });
    expect(rows[1].publishedAt).not.toBeNull();
    expect(rows[0].publishedAt).toBeNull();
  });

  test("a stored unpublished version with the same body is published in place; re-running is a no-op", async () => {
    const c = await creator();
    await db.insert(personaCards).values({ creatorId: c.id, version: 1, body: BODY, neverList: [] });
    expect(await publishCard(c.id, BODY)).toEqual({ version: 1, inserted: false, alreadyPublished: false });
    expect(await publishCard(c.id, BODY)).toEqual({ version: 1, inserted: false, alreadyPublished: true });
    expect(await cards(c.id)).toHaveLength(1);
  });

  test("publishing re-derives the stored never-list, for an unpublished and an already published version", async () => {
    const c = await creator();
    await db.insert(personaCards).values({ creatorId: c.id, version: 1, body: BODY, neverList: ["Never meet up."] });
    await publishCard(c.id, BODY);
    expect((await cards(c.id))[0].neverList).toEqual(["meet up"]);
    await db.update(personaCards).set({ neverList: ["stale"] }).where(eq(personaCards.creatorId, c.id));
    expect(await publishCard(c.id, BODY)).toMatchObject({ alreadyPublished: true });
    expect((await cards(c.id))[0].neverList).toEqual(["meet up"]);
  });

  test("two publishes of the same new body at once store it once", async () => {
    const c = await creator();
    await Promise.all([publishCard(c.id, BODY), publishCard(c.id, BODY)]);
    expect(await cards(c.id)).toHaveLength(1);
  });
});

describe("latestCardVersion", () => {
  test("picks the highest v<N>.md, numerically", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cards-"));
    for (const f of ["v1.md", "v2.md", "v10.md", "v3.meta.json", "notes.md"]) writeFileSync(path.join(dir, f), "x");
    expect(latestCardVersion(dir)).toBe(10);
  });
});
