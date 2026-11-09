import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vitest";
import { db, withTx } from "@/db/client";
import { ledgerEntries, users } from "@/db/schema";
import { grantWelcomeCredit, grantWelcomeCreditOnce, welcomeCreditCents } from "./grant";
import { assertBalanceEqualsLedger, balanceOf, makeFan, setConfig } from "./test-helpers";
import { makeUser } from "@/db/test-helpers";

beforeAll(() => setConfig());

const entries = (fanId: string) => db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, fanId));

describe("welcome credit", () => {
  test("welcome_credit_grants_5000_once", async () => {
    const fan = await makeFan();
    expect(await welcomeCreditCents()).toBe(5000);
    expect(await grantWelcomeCreditOnce(fan.id)).toBe("granted");
    expect(await grantWelcomeCreditOnce(fan.id)).toBe("already_granted");
    const rows = await entries(fan.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "grant", amountCents: 5000, idempotencyKey: `welcome:${fan.id}`, stripeEventId: null, creatorId: null });
    expect(await balanceOf(fan.id)).toBe(5000);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("welcome_credit_concurrent_calls_grant_once", async () => {
    const fan = await makeFan();
    const outcomes = await Promise.all([grantWelcomeCreditOnce(fan.id), grantWelcomeCreditOnce(fan.id), grantWelcomeCreditOnce(fan.id)]);
    expect(outcomes.filter((o) => o === "granted")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "already_granted")).toHaveLength(2);
    expect(await entries(fan.id)).toHaveLength(1);
    expect(await balanceOf(fan.id)).toBe(5000);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("welcome_credit_refused_for_flagged_fan", async () => {
    const fan = await makeFan();
    await db.update(users).set({ flaggedAt: new Date(), flagReason: "under_18_declared" }).where(eq(users.id, fan.id));
    expect(await grantWelcomeCreditOnce(fan.id)).toBe("ineligible");
    expect(await entries(fan.id)).toHaveLength(0);
    expect(await balanceOf(fan.id)).toBe(0);
  });

  test("welcome_credit_refused_before_adult_confirmation_and_for_non_fans", async () => {
    const unconfirmed = await makeUser({ role: "fan" });
    const creator = await makeUser({ role: "creator", adultConfirmedAt: new Date() });
    expect(await grantWelcomeCreditOnce(unconfirmed.id)).toBe("ineligible");
    expect(await grantWelcomeCreditOnce(creator.id)).toBe("ineligible");
    expect(await entries(unconfirmed.id)).toHaveLength(0);
    expect(await entries(creator.id)).toHaveLength(0);
  });

  test("the amount passed in is the amount credited, and a non-positive amount is refused", async () => {
    const fan = await makeFan();
    expect(await withTx((tx) => grantWelcomeCredit(tx, fan.id, 1234))).toBe("granted");
    expect(await balanceOf(fan.id)).toBe(1234);
    await expect(withTx((tx) => grantWelcomeCredit(tx, fan.id, 0))).rejects.toThrow();
  });

  test("a rolled-back transaction leaves no entry and no balance, so a retry grants", async () => {
    const fan = await makeFan();
    await expect(
      withTx(async (tx) => {
        await grantWelcomeCredit(tx, fan.id, 5000);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await entries(fan.id)).toHaveLength(0);
    expect(await grantWelcomeCreditOnce(fan.id)).toBe("granted");
    expect(await balanceOf(fan.id)).toBe(5000);
  });
});
