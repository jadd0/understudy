import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { config, creators, personaCards, personaChunks } from "@/db/schema";
import { makeCreator, makePersona } from "@understudy/engine/testing";
// @ts-expect-error -- plain ESM script without types
import { dump, restore } from "./backup-engine-data.mjs";

const dir = mkdtempSync(join(tmpdir(), "backup-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const vec = (n: number) => `[${Array.from({ length: 1024 }, (_, i) => (i === n ? 1 : 0)).join(",")}]`;

// Persona rows left by other test files would collide with a restore of the same ids.
const clearPersona = async () => {
  await db.delete(personaChunks);
  await db.delete(personaCards);
};

async function seedPersona() {
  await clearPersona();
  const creator = await makeCreator();
  const card = await makePersona(creator.id, "You are Juno.", ["my ex"]);
  await db.execute(sql`insert into persona_chunks (creator_id, source, source_url, text, meta, embedding)
    values (${creator.id}, 'caption', 'https://example.test/a', 'first chunk', '{"k":1}'::jsonb, ${vec(3)}::vector),
           (${creator.id}, 'card', null, 'second chunk', null, ${vec(7)}::vector)`);
  return { creator, card };
}

const rowsFor = async (creatorId: string) => ({
  cards: await db.select({ id: personaCards.id, version: personaCards.version, body: personaCards.body, neverList: personaCards.neverList }).from(personaCards).where(eq(personaCards.creatorId, creatorId)),
  chunks: (await db.execute(sql`select id, source::text, source_url, text, meta, embedding::text as embedding from persona_chunks where creator_id = ${creatorId} order by text`)).rows,
});

// A creator's user email is the key a restore matches on; a rebuilt database reseeds the creator under a new id.
async function replaceCreator(oldId: string) {
  const [old] = await db.select().from(creators).where(eq(creators.id, oldId));
  await db.delete(personaChunks).where(eq(personaChunks.creatorId, oldId));
  await db.delete(personaCards).where(eq(personaCards.creatorId, oldId));
  await db.delete(config).where(eq(config.creatorId, oldId));
  await db.delete(creators).where(eq(creators.id, oldId));
  const [fresh] = await db.insert(creators).values({ userId: old.userId, handle: `${old.handle}-2`, displayName: old.displayName }).returning();
  return fresh;
}

describe("backup-engine-data", () => {
  test("dump, reseed the creator under a new id, restore: persona rows equal and point at the new creator id", async () => {
    const { creator } = await seedPersona();
    const before = await rowsFor(creator.id);
    expect(before.cards).toHaveLength(1);
    expect(before.chunks).toHaveLength(2);
    const file = join(dir, "a.json");
    const counts = await dump(process.env.DATABASE_URL, file);
    expect(counts.cards).toBeGreaterThanOrEqual(1);

    const fresh = await replaceCreator(creator.id);
    expect(fresh.id).not.toBe(creator.id);
    const out = await restore(process.env.DATABASE_URL, file);
    expect(out.cards).toBe(counts.cards);
    const after = await rowsFor(fresh.id);
    expect(after).toEqual(before);
    expect((await rowsFor(creator.id)).chunks).toEqual([]);
  });

  test("a changed config row is reported, not written", async () => {
    await clearPersona();
    await db.insert(config).values({ key: "backup.test_key", value: 5 });
    const file = join(dir, "b.json");
    await dump(process.env.DATABASE_URL, file);
    await db.update(config).set({ value: 9 }).where(eq(config.key, "backup.test_key"));
    const out = await restore(process.env.DATABASE_URL, file);
    expect(out.differing.filter((d: { key: string }) => d.key === "backup.test_key")).toEqual([
      { key: "backup.test_key", creator_email: null, dumped: 5, current: 9 },
    ]);
    const [row] = await db.select().from(config).where(eq(config.key, "backup.test_key"));
    expect(row.value).toBe(9);
  });

  test("restoring into a database where the rows already exist fails and writes nothing", async () => {
    const { creator } = await seedPersona();
    const file = join(dir, "c.json");
    await dump(process.env.DATABASE_URL, file);
    // The card is gone but its chunks remain: the card insert succeeds, then the first chunk conflicts. Nothing may stay.
    const before = await rowsFor(creator.id);
    expect(before.chunks).toHaveLength(2);
    await db.delete(personaCards).where(eq(personaCards.creatorId, creator.id));
    await expect(restore(process.env.DATABASE_URL, file)).rejects.toBeTruthy();
    const after = await rowsFor(creator.id);
    expect(after.cards).toEqual([]);
    expect(after.chunks).toEqual(before.chunks);
  });
});
