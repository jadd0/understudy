import { randomUUID } from "node:crypto";
import { eq, inArray, isNull, and } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { catalogueItems, config, creators, users } from "@/db/schema";
import { WALLET_CONFIG, backfillWelcomeCredit, seed } from "@/db/seed";
import { ledgerEntries } from "@/db/schema";
import { makeUser } from "@/db/test-helpers";
import { balanceOf } from "@/lib/wallet/test-helpers";

async function removeCreatorsNamed(handle: string) {
  for (const c of await db.select().from(creators).where(eq(creators.handle, handle))) {
    await db.delete(catalogueItems).where(eq(catalogueItems.creatorId, c.id));
    await db.delete(creators).where(eq(creators.id, c.id));
  }
}

describe("wallet seed", () => {
  test("seeding twice leaves one catalogue and one config row per key", async () => {
    const email = `juno-${randomUUID()}@test.invalid`;
    const quiet = () => {};
    // The handle is unique platform-wide, so this test cleans up the creator it seeds for the other seed test.
    await removeCreatorsNamed("junovale");
    const [user] = await db.insert(users).values({ email, role: "creator" }).returning();
    try {
      await seed({ creatorEmail: email }, quiet);
      await seed({ creatorEmail: email }, quiet);
      await check(user.id);
    } finally {
      await removeCreatorsNamed("junovale");
    }
  });

  async function check(userId: string) {
    const [creator] = await db.select().from(creators).where(eq(creators.userId, userId));
    const items = await db.select().from(catalogueItems).where(eq(catalogueItems.creatorId, creator.id));
    expect(items.map((i) => `${i.kind}:${i.priceCents}`).sort()).toEqual(
      ["bundle:3499", "personal:4999", "ppv:1499", "ppv:1999", "ppv:999"].sort(),
    );

    const keys = Object.keys(WALLET_CONFIG);
    expect(keys.length).toBeGreaterThan(0);
    const rows = await db
      .select()
      .from(config)
      .where(and(inArray(config.key, keys), isNull(config.creatorId)));
    expect(rows.map((r) => r.key).sort()).toEqual([...keys].sort());
  }

  test("a re-seed keeps a config value that was edited", async () => {
    await seed({}, () => {});
    await db.update(config).set({ value: 30000 }).where(and(eq(config.key, "wallet.daily_cap_cents"), isNull(config.creatorId)));
    await seed({}, () => {});
    const [row] = await db.select().from(config).where(and(eq(config.key, "wallet.daily_cap_cents"), isNull(config.creatorId)));
    expect(row.value).toBe(30000);
    await db.update(config).set({ value: 20000 }).where(eq(config.id, row.id));
  });

  test("the welcome backfill credits each confirmed unflagged fan once and nobody else", async () => {
    await seed({}, () => {});
    const adult = await makeUser({ role: "fan", adultConfirmedAt: new Date("2026-01-01T00:00:00Z") });
    const flagged = await makeUser({ role: "fan", adultConfirmedAt: new Date("2026-01-01T00:00:00Z"), flaggedAt: new Date() });
    const pending = await makeUser({ role: "fan" });
    const evalFan = await makeUser({ role: "fan", email: `eval+${randomUUID()}@understudy.test`, adultConfirmedAt: new Date("2026-01-01T00:00:00Z") });
    const ids = [adult.id, flagged.id, pending.id, evalFan.id];
    expect(await backfillWelcomeCredit(ids)).toBe(1);
    expect(await backfillWelcomeCredit(ids)).toBe(0);
    expect(await backfillWelcomeCredit([])).toBe(0);
    expect(await balanceOf(adult.id)).toBe(5000);
    for (const id of [flagged.id, pending.id, evalFan.id]) expect(await balanceOf(id)).toBe(0);
    const grants = await db.select().from(ledgerEntries).where(inArray(ledgerEntries.fanId, ids));
    expect(grants.map((g) => [g.fanId, g.kind, g.amountCents])).toEqual([[adult.id, "grant", 5000]]);
  });
});
