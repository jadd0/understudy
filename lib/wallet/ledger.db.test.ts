import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db, withTx } from "@/db/client";
import { ledgerEntries } from "@/db/schema";
import { InsufficientFunds, InvalidAmount } from "@/lib/wallet/errors";
import { credit, debit } from "@/lib/wallet/ledger";
import { CAP, assertBalanceEqualsLedger, balanceOf, fund, makeCreator, makeFan } from "./test-helpers";

describe("ledger primitives", () => {
  test("credit then debit moves the balance and the ledger together", async () => {
    const fan = await makeFan();
    const creator = await makeCreator();
    await fund(fan.id, 1000);
    const res = await withTx((tx) =>
      debit(tx, { fanId: fan.id, kind: "tip", creatorId: creator.id, amountCents: 300, platformCapCents: CAP }),
    );
    expect(res).toMatchObject({ balanceCents: 700, replayed: false });
    expect(await balanceOf(fan.id)).toBe(700);
    const rows = await db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, fan.id));
    expect(rows.map((r) => `${r.kind}:${r.amountCents}`).sort()).toEqual(["tip:-300", "topup:1000"]);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("a debit over the balance throws InsufficientFunds and writes nothing", async () => {
    const fan = await makeFan();
    const creator = await makeCreator();
    await fund(fan.id, 500);
    await expect(
      withTx((tx) => debit(tx, { fanId: fan.id, kind: "tip", creatorId: creator.id, amountCents: 501, platformCapCents: CAP })),
    ).rejects.toBeInstanceOf(InsufficientFunds);
    const rows = await db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, fan.id));
    expect(rows).toHaveLength(1);
    expect(await balanceOf(fan.id)).toBe(500);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("a debit on a fan with no wallet row creates it empty and refuses", async () => {
    const fan = await makeFan();
    const creator = await makeCreator();
    await expect(
      withTx((tx) => debit(tx, { fanId: fan.id, kind: "tip", creatorId: creator.id, amountCents: 1, platformCapCents: CAP })),
    ).rejects.toBeInstanceOf(InsufficientFunds);
  });

  test("the same stripe event id credits once", async () => {
    const fan = await makeFan();
    const evt = `evt_${randomUUID()}`;
    const a = await withTx((tx) => credit(tx, { fanId: fan.id, kind: "topup", amountCents: 1000, stripeEventId: evt }));
    const b = await withTx((tx) => credit(tx, { fanId: fan.id, kind: "topup", amountCents: 1000, stripeEventId: evt }));
    expect(a.replayed).toBe(false);
    expect(b).toMatchObject({ replayed: true, ledgerEntryId: a.ledgerEntryId, balanceCents: 1000 });
    expect(await balanceOf(fan.id)).toBe(1000);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("zero, negative and fractional amounts are refused before any write", async () => {
    const fan = await makeFan();
    const creator = await makeCreator();
    for (const amountCents of [0, -5, 1.5, Number.NaN]) {
      await expect(withTx((tx) => credit(tx, { fanId: fan.id, kind: "topup", amountCents }))).rejects.toBeInstanceOf(InvalidAmount);
      await expect(
        withTx((tx) => debit(tx, { fanId: fan.id, kind: "tip", creatorId: creator.id, amountCents, platformCapCents: CAP })),
      ).rejects.toBeInstanceOf(InvalidAmount);
    }
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, fan.id))).toHaveLength(0);
  });
});

async function pgError(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const cause = (e as { cause?: { code?: string; constraint?: string; message?: string } }).cause;
    return { code: cause?.code, constraint: cause?.constraint };
  }
  return null;
}

describe("ledger is append-only in the database", () => {
  test("negative_topup_insert_refused_by_db", async () => {
    const fan = await makeFan();
    for (const kind of ["topup", "refund", "grant"] as const) {
      expect(await pgError(db.insert(ledgerEntries).values({ fanId: fan.id, kind, amountCents: -100 }))).toEqual({
        code: "23514",
        constraint: "ledger_entries_sign_by_kind",
      });
      expect(await pgError(db.insert(ledgerEntries).values({ fanId: fan.id, kind, amountCents: 0 }))).toMatchObject({
        constraint: "ledger_entries_sign_by_kind",
      });
    }
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, fan.id))).toHaveLength(0);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("positive_unlock_insert_refused_by_db", async () => {
    const fan = await makeFan();
    for (const kind of ["unlock", "tip"] as const) {
      expect(await pgError(db.insert(ledgerEntries).values({ fanId: fan.id, kind, amountCents: 100 }))).toEqual({
        code: "23514",
        constraint: "ledger_entries_sign_by_kind",
      });
    }
    // The allowed sign for each kind is accepted, so the refusals above are about the sign alone.
    await db.insert(ledgerEntries).values({ fanId: fan.id, kind: "grant", amountCents: 100 });
    await db.insert(ledgerEntries).values({ fanId: fan.id, kind: "tip", amountCents: -100 });
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, fan.id))).toHaveLength(2);
  });

  test("update_ledger_row_refused", async () => {
    const fan = await makeFan();
    await fund(fan.id, 1000);
    const before = await db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, fan.id));
    expect(before).toHaveLength(1);
    const err = await pgError(db.update(ledgerEntries).set({ amountCents: 9999 }).where(eq(ledgerEntries.fanId, fan.id)));
    expect(err?.code).toBe("23001");
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, fan.id))).toEqual(before);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("delete_ledger_row_refused", async () => {
    const fan = await makeFan();
    await fund(fan.id, 1000);
    const err = await pgError(db.delete(ledgerEntries).where(eq(ledgerEntries.fanId, fan.id)));
    expect(err?.code).toBe("23001");
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, fan.id))).toHaveLength(1);
    expect(await balanceOf(fan.id)).toBe(1000);
    await assertBalanceEqualsLedger(fan.id);
  });
});
