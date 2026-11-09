import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { db, withTx } from "@/db/client";
import { ledgerEntries } from "@/db/schema";
import { getFanCap, setFanCap, spentToday } from "@/lib/wallet/cap";
import { CapReached, InvalidAmount } from "@/lib/wallet/errors";
import { randomUUID } from "node:crypto";
import { tip } from "@/lib/wallet/tip";
import { wallets } from "@/db/schema";
import { assertBalanceEqualsLedger, balanceOf, fund, makeCreator, makeFan, setConfig } from "./test-helpers";

beforeAll(() => setConfig({ "wallet.daily_cap_cents": 1000 }));
afterEach(() => setConfig({ "wallet.daily_cap_cents": 1000 }));

/** A debit row stamped a number of minutes before the start of today (UTC), by the database clock. */
async function pastDebit(fanId: string, creatorId: string, cents: number, minutesBeforeToday: number) {
  await db.insert(ledgerEntries).values({
    fanId,
    creatorId,
    kind: "tip",
    amountCents: -cents,
    createdAt: sql`(date_trunc('day', now() at time zone 'UTC') at time zone 'UTC') - make_interval(mins => ${minutesBeforeToday})`,
  });
}

describe("cap ceiling", () => {
  test("raise_above_ceiling_is_InvalidAmount", async () => {
    await setConfig({ "wallet.daily_cap_cents": 1000, "cap.max_daily_cents": 5000 });
    const fan = await makeFan();
    await expect(setFanCap(fan.id, 5001, new Date("2026-11-03T12:00:00.000Z"))).rejects.toBeInstanceOf(InvalidAmount);
    const [row] = await db.select().from(wallets).where(eq(wallets.fanId, fan.id));
    expect(row?.pendingCapCents ?? null).toBeNull();
  });

  test("ceiling_exact_is_ok", async () => {
    await setConfig({ "wallet.daily_cap_cents": 1000, "cap.max_daily_cents": 5000 });
    const fan = await makeFan();
    const res = await setFanCap(fan.id, 5000, new Date("2026-11-03T12:00:00.000Z"));
    expect(res.pending?.cents).toBe(5000);
  });
});

describe("daily cap", () => {
  test("a debit that takes today over the cap is CapReached; exactly at the cap passes", async () => {
    const fan = await makeFan();
    const creator = await makeCreator();
    await fund(fan.id, 5000);
    await tip(fan.id, creator.id, 600, randomUUID());
    await expect(tip(fan.id, creator.id, 401, randomUUID())).rejects.toBeInstanceOf(CapReached);
    await tip(fan.id, creator.id, 400, randomUUID());
    expect(await balanceOf(fan.id)).toBe(4000);
    await expect(tip(fan.id, creator.id, 1, randomUUID())).rejects.toBeInstanceOf(CapReached);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("yesterday's debits do not count; credits do not reduce today's spend", async () => {
    const fan = await makeFan();
    const creator = await makeCreator();
    await fund(fan.id, 5000);
    await pastDebit(fan.id, creator.id, 900, 1); // one minute before midnight UTC
    // The seeded debit bypassed the primitive, so restore balance = ledger sum before asserting it.
    await db.execute(sql`update wallets set balance_cents = balance_cents - 900 where fan_id = ${fan.id}`);
    expect(await withTx((tx) => spentToday(tx, fan.id))).toBe(0);
    await tip(fan.id, creator.id, 1000, randomUUID());
    expect(await withTx((tx) => spentToday(tx, fan.id))).toBe(1000);
    await assertBalanceEqualsLedger(fan.id);
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, fan.id))).toHaveLength(3);
  });
});

describe("per-fan cap", () => {
  const T0 = new Date("2026-11-03T12:00:00.000Z");
  const hours = (n: number) => new Date(T0.getTime() + n * 3_600_000);

  test("with no own cap the platform default is in force", async () => {
    const fan = await makeFan();
    expect(await getFanCap(fan.id, T0)).toEqual({ effectiveCents: 1000, pending: null });
  });

  test("lowering is immediate and enforced by debit", async () => {
    const fan = await makeFan();
    const creator = await makeCreator();
    await fund(fan.id, 5000);
    expect(await setFanCap(fan.id, 700, T0)).toEqual({ effectiveCents: 700, pending: null });
    await expect(tip(fan.id, creator.id, 701, randomUUID())).rejects.toBeInstanceOf(CapReached);
    await tip(fan.id, creator.id, 700, randomUUID());
    await assertBalanceEqualsLedger(fan.id);
  });

  test("raising is pending, not effective at 23h59m, effective at 24h (injected clock)", async () => {
    const fan = await makeFan();
    await setFanCap(fan.id, 600, T0);
    const res = await setFanCap(fan.id, 3000, T0);
    expect(res.effectiveCents).toBe(600);
    expect(res.pending).toEqual({ cents: 3000, at: hours(24) });
    expect((await getFanCap(fan.id, new Date(hours(24).getTime() - 1))).effectiveCents).toBe(600);
    expect(await getFanCap(fan.id, hours(24))).toEqual({ effectiveCents: 3000, pending: null });
    const [row] = await db.select().from(wallets).where(eq(wallets.fanId, fan.id));
    expect(row).toMatchObject({ dailyCapCents: 3000, pendingCapCents: null, pendingCapAt: null });
  });

  test("raising above the platform default also waits", async () => {
    const fan = await makeFan();
    const res = await setFanCap(fan.id, 5000, T0);
    expect(res.effectiveCents).toBe(1000);
    expect(res.pending?.cents).toBe(5000);
  });

  test("lowering again cancels a pending raise", async () => {
    const fan = await makeFan();
    await setFanCap(fan.id, 2000, T0);
    expect((await setFanCap(fan.id, 800, hours(1))).pending).toBeNull();
    expect(await getFanCap(fan.id, hours(48))).toEqual({ effectiveCents: 800, pending: null });
  });

  test("a debit after the cooling-off period uses the raised cap", async () => {
    const fan = await makeFan();
    const creator = await makeCreator();
    await fund(fan.id, 5000);
    await setFanCap(fan.id, 600, T0);
    await setFanCap(fan.id, 3000, T0);
    const { debit } = await import("@/lib/wallet/ledger");
    const base = { fanId: fan.id, kind: "tip" as const, creatorId: creator.id, amountCents: 2000, platformCapCents: 1000 };
    await expect(withTx((tx) => debit(tx, { ...base, now: hours(23) }))).rejects.toBeInstanceOf(CapReached);
    await withTx((tx) => debit(tx, { ...base, now: hours(25) }));
    await assertBalanceEqualsLedger(fan.id);
  });

  test("below the minimum, zero and fractional caps are refused", async () => {
    const fan = await makeFan();
    for (const cents of [499, 0, -1, 600.5]) {
      await expect(setFanCap(fan.id, cents, T0)).rejects.toBeInstanceOf(InvalidAmount);
    }
    expect((await getFanCap(fan.id, T0)).effectiveCents).toBe(1000);
    await setFanCap(fan.id, 500, T0);
    expect((await getFanCap(fan.id, T0)).effectiveCents).toBe(500);
  });

  test("concurrent tips respect a fan's own cap", async () => {
    const fan = await makeFan();
    const creator = await makeCreator();
    await fund(fan.id, 5000);
    await setFanCap(fan.id, 500, T0);
    const settled = await Promise.allSettled(Array.from({ length: 5 }, () => tip(fan.id, creator.id, 200, randomUUID())));
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(settled.filter((r) => r.status === "rejected" && r.reason instanceof CapReached)).toHaveLength(3);
    await assertBalanceEqualsLedger(fan.id);
  });
});
