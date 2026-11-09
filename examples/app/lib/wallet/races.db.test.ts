import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { beforeAll, describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { ledgerEntries, unlocks } from "@/db/schema";
import { CapReached, InsufficientFunds } from "@/lib/wallet/errors";
import { tip } from "@/lib/wallet/tip";
import { applyCheckoutEvent } from "@/lib/wallet/topup";
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

// Each call below opens its own transaction on its own pooled connection, so these really overlap.
beforeAll(() => setConfig());

const rows = (fanId: string) => db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, fanId));
const outcomes = (settled: PromiseSettledResult<unknown>[]) => ({
  ok: settled.filter((r) => r.status === "fulfilled").length,
  errors: settled.flatMap((r) => (r.status === "rejected" ? [(r.reason as Error).name] : [])),
});

describe("wallet races", () => {
  test("the same offer unlocked 10 times at once debits exactly once", async () => {
    const fan = await makeFan();
    const creator = await makeCreator();
    const item = await makeItem(creator.id, 999);
    const conv = await makeConversation(creator.id, fan.id);
    await fund(fan.id, 5000);
    const offer = await makeOffer(conv.id, item.id, 999);

    const results = await Promise.all(Array.from({ length: 10 }, () => unlockOffer(fan.id, offer.id)));
    expect(results.filter((r) => !r.alreadyUnlocked)).toHaveLength(1);
    expect(results.filter((r) => r.alreadyUnlocked)).toHaveLength(9);
    expect((await rows(fan.id)).filter((r) => r.kind === "unlock")).toHaveLength(1);
    expect(await db.select().from(unlocks).where(eq(unlocks.fanId, fan.id))).toHaveLength(1);
    expect(await balanceOf(fan.id)).toBe(4001);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("two different offers with money for one: exactly one wins, the other is InsufficientFunds", async () => {
    const fan = await makeFan();
    const creator = await makeCreator();
    const conv = await makeConversation(creator.id, fan.id);
    const itemA = await makeItem(creator.id, 999);
    const itemB = await makeItem(creator.id, 999);
    await fund(fan.id, 1000);
    const a = await makeOffer(conv.id, itemA.id, 999);
    const b = await makeOffer(conv.id, itemB.id, 999);

    const settled = await Promise.allSettled([unlockOffer(fan.id, a.id), unlockOffer(fan.id, b.id)]);
    expect(outcomes(settled)).toEqual({ ok: 1, errors: [InsufficientFunds.name] });
    expect(await balanceOf(fan.id)).toBe(1);
    expect((await rows(fan.id)).filter((r) => r.kind === "unlock")).toHaveLength(1);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("two offers for the same item at once are two purchases and keep one unlocks row", async () => {
    const fan = await makeFan();
    const creator = await makeCreator();
    const conv = await makeConversation(creator.id, fan.id);
    const item = await makeItem(creator.id, 999);
    await fund(fan.id, 5000);
    const a = await makeOffer(conv.id, item.id, 999);
    const b = await makeOffer(conv.id, item.id, 999);

    const results = await Promise.all([unlockOffer(fan.id, a.id), unlockOffer(fan.id, b.id)]);
    expect(results.filter((r) => !r.alreadyUnlocked)).toHaveLength(2);
    expect((await rows(fan.id)).filter((r) => r.kind === "unlock")).toHaveLength(2);
    expect(await db.select().from(unlocks).where(eq(unlocks.fanId, fan.id))).toHaveLength(1);
    expect(await balanceOf(fan.id)).toBe(3002);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("the same webhook event applied 5 times at once credits once", async () => {
    const fan = await makeFan();
    const event = {
      id: `evt_${randomUUID()}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          payment_status: "paid",
          currency: "usd",
          amount_total: 2500,
          metadata: { fan_id: fan.id },
        },
      },
    } as unknown as Stripe.Event;

    const results = await Promise.all(Array.from({ length: 5 }, () => applyCheckoutEvent(event)));
    expect(results.filter((r) => r === "credited")).toHaveLength(1);
    expect(results.filter((r) => r === "duplicate")).toHaveLength(4);
    expect(await rows(fan.id)).toHaveLength(1);
    expect(await balanceOf(fan.id)).toBe(2500);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("a tip with the same key 5 times at once debits once", async () => {
    const fan = await makeFan();
    const creator = await makeCreator();
    await fund(fan.id, 1000);
    const key = randomUUID();

    const results = await Promise.all(Array.from({ length: 5 }, () => tip(fan.id, creator.id, 250, key)));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.ledgerEntryId)).size).toBe(1);
    expect((await rows(fan.id)).filter((r) => r.kind === "tip")).toHaveLength(1);
    expect(await balanceOf(fan.id)).toBe(750);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("concurrent tips that each fit the cap but not together: only the ones under the cap land", async () => {
    await setConfig({ "wallet.daily_cap_cents": 500 });
    try {
      const fan = await makeFan();
      const creator = await makeCreator();
      await fund(fan.id, 5000);
      const settled = await Promise.allSettled(
        Array.from({ length: 6 }, () => tip(fan.id, creator.id, 200, randomUUID())),
      );
      expect(outcomes(settled)).toEqual({ ok: 2, errors: Array(4).fill(CapReached.name) });
      expect(await balanceOf(fan.id)).toBe(4600);
      await assertBalanceEqualsLedger(fan.id);
    } finally {
      await setConfig();
    }
  });

  test("concurrent tips never take the balance below zero", async () => {
    const fan = await makeFan();
    const creator = await makeCreator();
    await fund(fan.id, 700);
    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, () => tip(fan.id, creator.id, 300, randomUUID())),
    );
    expect(outcomes(settled)).toEqual({ ok: 2, errors: Array(4).fill(InsufficientFunds.name) });
    expect(await balanceOf(fan.id)).toBe(100);
    await assertBalanceEqualsLedger(fan.id);
  });
});
