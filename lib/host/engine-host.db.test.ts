import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vitest";
import { db, withTx } from "@/db/client";
import { ledgerEntries, offers, unlocks, users, wallets } from "@/db/schema";
import { sql } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import { capAllows } from "@/lib/wallet/cap";
import { isHighValue } from "@/lib/wallet/score";
import { makeConversation, makeCreator, makeFan, makeItem, setEngineConfig } from "@understudy/engine/testing";
import { dbHost } from "./engine-host";

beforeAll(async () => {
  await setEngineConfig();
});

async function world() {
  const creator = await makeCreator();
  const fan = await makeFan();
  const conv = await makeConversation(creator.id, fan.id);
  const a = await makeItem(creator.id, { title: "A", priceCents: 500 });
  const b = await makeItem(creator.id, { title: "B", priceCents: 700 });
  const c = await makeItem(creator.id, { title: "C", priceCents: 900, kind: "bundle" });
  return { creator, fan, conv, a, b, c };
}

async function unlock(fanId: string, creatorId: string, itemId: string, cents: number) {
  const [entry] = await db.insert(ledgerEntries).values({ fanId, kind: "unlock", amountCents: -cents, creatorId }).returning();
  await db.insert(unlocks).values({ fanId, itemId, ledgerEntryId: entry.id });
}

describe("fanFacts", () => {
  test("spent, cap, high value and unlocks in the window match the wallet's own reads on a seeded fan", async () => {
    const w = await world();
    const platformCap = await getConfig<number>("wallet.daily_cap_cents");
    const q = { fanId: w.fan.id, creatorId: w.creator.id, velocityWindowMinutes: 30 };

    const empty = await dbHost.fanFacts(q);
    expect(empty).toMatchObject({ spentTodayCents: 0, capCents: platformCap, atCap: false, unlocksInWindow: 0 });

    await unlock(w.fan.id, w.creator.id, w.a.id, 500);
    await unlock(w.fan.id, w.creator.id, w.b.id, 700);
    const seeded = await dbHost.fanFacts(q);
    expect(seeded.spentTodayCents).toBe(1200);
    expect(seeded.unlocksInWindow).toBe(2);
    // A zero-minute window excludes everything already written: velocity counts only the window, spend does not.
    expect(await dbHost.fanFacts({ ...q, velocityWindowMinutes: 0 })).toMatchObject({ spentTodayCents: 1200, unlocksInWindow: 0 });
    expect(seeded.highValue).toBe(await isHighValue(w.fan.id, w.creator.id));
    expect(seeded.atCap).toBe(!capAllows(seeded.spentTodayCents, 1, seeded.capCents));

    // His own cap replaces the platform's, and a spend that reaches it puts him at cap.
    await db.insert(wallets).values({ fanId: w.fan.id, dailyCapCents: seeded.spentTodayCents }).onConflictDoUpdate({
      target: wallets.fanId,
      set: { dailyCapCents: seeded.spentTodayCents },
    });
    const capped = await dbHost.fanFacts(q);
    expect(capped.capCents).toBe(seeded.spentTodayCents);
    expect(capped.atCap).toBe(true);
  });
});

describe("catalogue", () => {
  test("shortlist excludes owned items and open offers and respects kinds; the owned list is the complement", async () => {
    const w = await world();
    const q = { creatorId: w.creator.id, fanId: w.fan.id, conversationId: w.conv.id };
    const titles = async (p: Promise<{ title: string }[]>) => (await p).map((i) => i.title);
    expect(await titles(dbHost.catalogue.shortlist(q))).toEqual(["A", "B", "C"]);
    expect(await titles(dbHost.catalogue.shortlist({ ...q, kinds: ["ppv"] }))).toEqual(["A", "B"]);
    expect(await titles(dbHost.catalogue.ownedShortlist(q))).toEqual([]);
    expect(await dbHost.catalogue.ownsEverything(w.creator.id, w.fan.id)).toBe(false);

    await unlock(w.fan.id, w.creator.id, w.c.id, 900);
    await db.insert(offers).values({
      conversationId: w.conv.id,
      itemId: w.a.id,
      priceCents: 100,
      status: "open",
      expiresAt: sql`now() + interval '1 hour'`,
    });
    expect(await titles(dbHost.catalogue.shortlist(q))).toEqual(["B"]);
    const owned = await dbHost.catalogue.ownedShortlist(q);
    expect(owned.map((i) => [i.title, i.owned])).toEqual([["C", true]]);

    await unlock(w.fan.id, w.creator.id, w.a.id, 500);
    await unlock(w.fan.id, w.creator.id, w.b.id, 700);
    expect(await dbHost.catalogue.ownsEverything(w.creator.id, w.fan.id)).toBe(true);
    expect(await dbHost.catalogue.shortlist(q)).toEqual([]);
  });

  test("items and owns answer by id and tolerate an empty list", async () => {
    const w = await world();
    await unlock(w.fan.id, w.creator.id, w.b.id, 700);
    const items = await dbHost.items([w.a.id, w.b.id]);
    expect(items.get(w.a.id)).toEqual({ title: "A", priceCents: 500, kind: "ppv" });
    expect(items.get(w.b.id)?.title).toBe("B");
    expect(await dbHost.items([])).toEqual(new Map());
    expect([...(await dbHost.owns(w.fan.id, [w.a.id, w.b.id]))]).toEqual([w.b.id]);
    expect(await dbHost.owns(w.fan.id, [])).toEqual(new Set());
  });
});

describe("flagFan", () => {
  test("inside a transaction it sets flagged_at once (coalesce), maps minor to minor_in_chat, and a rollback undoes it", async () => {
    const w = await world();
    const read = async () => (await db.select({ at: users.flaggedAt, reason: users.flagReason }).from(users).where(eq(users.id, w.fan.id)))[0];

    await expect(
      withTx(async (tx) => {
        await dbHost.flagFan(tx, w.fan.id, "minor");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await read()).toEqual({ at: null, reason: null });

    await withTx((tx) => dbHost.flagFan(tx, w.fan.id, "minor"));
    const first = await read();
    expect(first.reason).toBe("minor_in_chat");
    expect(first.at).toBeInstanceOf(Date);

    await withTx((tx) => dbHost.flagFan(tx, w.fan.id, "threat"));
    expect(await read()).toEqual(first);
  });
});
