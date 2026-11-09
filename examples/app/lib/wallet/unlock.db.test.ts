import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { catalogueItems, ledgerEntries, offers, unlocks, users } from "@/db/schema";
import { InsufficientFunds, NotAllowed, NotYourOffer, OfferUnavailable } from "@/lib/wallet/errors";
import { unlockOffer } from "@/lib/wallet/unlock";
import {
  assertBalanceEqualsLedger,
  balanceOf,
  fund,
  makeConversation,
  makeCreator,
  makeFan,
  makeItem,
  makeOffer,
  setConfig,
} from "./test-helpers";

beforeAll(() => setConfig());

async function setup(price = 999) {
  const fan = await makeFan();
  const creator = await makeCreator();
  const item = await makeItem(creator.id, price);
  const conv = await makeConversation(creator.id, fan.id);
  return { fan, creator, item, conv };
}

const entries = (fanId: string) => db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, fanId));

describe("unlockOffer", () => {
  test("a re-offer of an owned item charges its price again: offer accepted, one unlocks row, two ledger entries", async () => {
    const { fan, creator, item, conv } = await setup();
    await fund(fan.id, 3000);
    const first = await makeOffer(conv.id, item.id, 999);
    const bought = await unlockOffer(fan.id, first.id);
    const second = await makeOffer(conv.id, item.id, 999);
    const again = await unlockOffer(fan.id, second.id);
    expect(again).toMatchObject({ alreadyUnlocked: false, itemId: item.id, balanceCents: 1002 });
    const [after] = await db.select().from(offers).where(eq(offers.id, second.id));
    expect(after.status).toBe("accepted");
    expect(after.resolvedAt).toBeInstanceOf(Date);
    const debits = (await entries(fan.id)).filter((e) => e.kind === "unlock");
    expect(debits).toHaveLength(2);
    expect(debits.map((e) => e.offerId).sort()).toEqual([first.id, second.id].sort());
    expect(debits.every((e) => e.amountCents === -999 && e.creatorId === creator.id && e.conversationId === conv.id)).toBe(true);
    // Ownership stays one row, still pointing at the first purchase.
    const owned = await db.select().from(unlocks).where(eq(unlocks.fanId, fan.id));
    expect(owned).toHaveLength(1);
    expect(bought.alreadyUnlocked === false && owned[0].ledgerEntryId === bought.ledgerEntryId).toBe(true);
    expect(await balanceOf(fan.id)).toBe(1002);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("the same offer unlocked twice charges once; the repeat returns alreadyUnlocked", async () => {
    const { fan, item, conv } = await setup();
    await fund(fan.id, 3000);
    const offer = await makeOffer(conv.id, item.id, 999);
    expect(await unlockOffer(fan.id, offer.id)).toMatchObject({ alreadyUnlocked: false });
    expect(await unlockOffer(fan.id, offer.id)).toMatchObject({ alreadyUnlocked: true, itemId: item.id, conversationId: conv.id });
    expect((await entries(fan.id)).filter((e) => e.kind === "unlock")).toHaveLength(1);
    expect(await balanceOf(fan.id)).toBe(2001);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("flagged_fan_cannot_unlock_and_nothing_changes", async () => {
    const { fan, item, conv } = await setup();
    await fund(fan.id, 2000);
    const offer = await makeOffer(conv.id, item.id, 999);
    await db.update(users).set({ flaggedAt: new Date() }).where(eq(users.id, fan.id));
    await expect(unlockOffer(fan.id, offer.id)).rejects.toBeInstanceOf(NotAllowed);
    const [after] = await db.select().from(offers).where(eq(offers.id, offer.id));
    expect(after.status).toBe("open");
    expect(await db.select().from(unlocks).where(eq(unlocks.fanId, fan.id))).toHaveLength(0);
    expect(await balanceOf(fan.id)).toBe(2000);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("creator_role_cannot_unlock", async () => {
    const { fan, creator, item, conv } = await setup();
    await fund(fan.id, 2000);
    const offer = await makeOffer(conv.id, item.id, 999);
    await db.update(users).set({ role: "creator" }).where(eq(users.id, fan.id));
    await expect(unlockOffer(fan.id, offer.id)).rejects.toBeInstanceOf(NotAllowed);
    expect(await balanceOf(fan.id)).toBe(2000);
    expect(creator.id).toBeTruthy();
  });

  test("two concurrent unlocks of different offers for one item are two purchases, one unlocks row", async () => {
    const { fan, item, conv } = await setup();
    await fund(fan.id, 3000);
    const a = await makeOffer(conv.id, item.id, 999);
    const b = await makeOffer(conv.id, item.id, 999);
    const results = await Promise.all([unlockOffer(fan.id, a.id), unlockOffer(fan.id, b.id)]);
    expect(results.filter((r) => !r.alreadyUnlocked)).toHaveLength(2);
    expect((await entries(fan.id)).filter((e) => e.kind === "unlock")).toHaveLength(2);
    expect(await db.select().from(unlocks).where(eq(unlocks.fanId, fan.id))).toHaveLength(1);
    const rows = await Promise.all([a, b].map((o) => db.select().from(offers).where(eq(offers.id, o.id))));
    expect(rows.map((r) => r[0].status)).toEqual(["accepted", "accepted"]);
    expect(await balanceOf(fan.id)).toBe(1002);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("happy path: debits the offer price, records the unlock, accepts the offer", async () => {
    const { fan, creator, item, conv } = await setup();
    await fund(fan.id, 2000);
    const offer = await makeOffer(conv.id, item.id, 999);
    const res = await unlockOffer(fan.id, offer.id);
    expect(res).toMatchObject({ alreadyUnlocked: false, itemId: item.id, balanceCents: 1001 });

    const [row] = await db.select().from(unlocks).where(eq(unlocks.fanId, fan.id));
    expect(row.itemId).toBe(item.id);
    const debits = (await entries(fan.id)).filter((e) => e.kind === "unlock");
    expect(debits).toHaveLength(1);
    expect(debits[0]).toMatchObject({ amountCents: -999, offerId: offer.id, creatorId: creator.id, id: row.ledgerEntryId });
    const [after] = await db.select().from(offers).where(eq(offers.id, offer.id));
    expect(after.status).toBe("accepted");
    expect(debits[0].conversationId).toBe(conv.id);
    expect(after.resolvedAt).toBeInstanceOf(Date);
    expect(after.createdAt).toBeInstanceOf(Date);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("an expired offer is unavailable and charges nothing", async () => {
    const { fan, item, conv } = await setup();
    await fund(fan.id, 2000);
    const offer = await makeOffer(conv.id, item.id, 999, { expiresInSeconds: -60 });
    await expect(unlockOffer(fan.id, offer.id)).rejects.toBeInstanceOf(OfferUnavailable);
    expect(await balanceOf(fan.id)).toBe(2000);
    expect(await db.select().from(unlocks).where(eq(unlocks.fanId, fan.id))).toHaveLength(0);
  });

  test("declined and expired-status offers are unavailable", async () => {
    const { fan, item, conv } = await setup();
    await fund(fan.id, 2000);
    for (const status of ["declined", "expired"] as const) {
      const offer = await makeOffer(conv.id, item.id, 999, { status });
      await expect(unlockOffer(fan.id, offer.id)).rejects.toBeInstanceOf(OfferUnavailable);
    }
    expect(await balanceOf(fan.id)).toBe(2000);
  });

  test("an unknown offer is unavailable", async () => {
    const fan = await makeFan();
    await expect(unlockOffer(fan.id, "00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(OfferUnavailable);
  });

  test("someone else's offer is refused and charges neither fan", async () => {
    const { fan, creator, item, conv } = await setup();
    const other = await makeFan();
    await fund(fan.id, 2000);
    await fund(other.id, 2000);
    const offer = await makeOffer(conv.id, item.id, 999);
    await expect(unlockOffer(other.id, offer.id)).rejects.toBeInstanceOf(NotYourOffer);
    expect(await balanceOf(other.id)).toBe(2000);
    expect(await balanceOf(fan.id)).toBe(2000);
    expect(creator.id).toBeTruthy();
  });

  test("insufficient funds leaves the offer open and writes nothing", async () => {
    const { fan, item, conv } = await setup();
    await fund(fan.id, 500);
    const offer = await makeOffer(conv.id, item.id, 999);
    await expect(unlockOffer(fan.id, offer.id)).rejects.toBeInstanceOf(InsufficientFunds);
    const [after] = await db.select().from(offers).where(eq(offers.id, offer.id));
    expect(after.status).toBe("open");
    expect(await db.select().from(unlocks).where(eq(unlocks.fanId, fan.id))).toHaveLength(0);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("a re-offer of an owned item he cannot afford is InsufficientFunds and leaves the offer open", async () => {
    const { fan, item, conv } = await setup();
    await fund(fan.id, 1500);
    await unlockOffer(fan.id, (await makeOffer(conv.id, item.id, 999)).id);
    const second = await makeOffer(conv.id, item.id, 999);
    await expect(unlockOffer(fan.id, second.id)).rejects.toBeInstanceOf(InsufficientFunds);
    expect((await db.select().from(offers).where(eq(offers.id, second.id)))[0].status).toBe("open");
    expect(await balanceOf(fan.id)).toBe(501);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("the offer's copied price is charged, not the catalogue's current price", async () => {
    const { fan, item, conv } = await setup(999);
    await fund(fan.id, 3000);
    const offer = await makeOffer(conv.id, item.id, 999);
    await db.update(catalogueItems).set({ priceCents: 4999 }).where(eq(catalogueItems.id, item.id));
    await unlockOffer(fan.id, offer.id);
    expect(await balanceOf(fan.id)).toBe(2001);
  });
});
