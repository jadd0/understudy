import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { db } from "@/db/client";
import { ledgerEntries, uncreditedPayments, users } from "@/db/schema";
import type { StripeProvider } from "@/providers/stripe";
import { InvalidAmount } from "@/lib/wallet/errors";
import { applyCheckoutEvent, applyPaymentIntentSucceeded, startTopupIntent, startTopup } from "@/lib/wallet/topup";
import { listOpenUncredited, resolveUncredited } from "@/lib/wallet/uncredited";
import { assertBalanceEqualsLedger, balanceOf, makeFan, setConfig } from "./test-helpers";

beforeAll(() => setConfig());

function completed(over: {
  id?: string;
  fanId?: string;
  amount?: number;
  paid?: string;
  currency?: string;
  type?: string;
  sessionId?: string;
}): Stripe.Event {
  return {
    id: over.id ?? `evt_${randomUUID()}`,
    type: over.type ?? "checkout.session.completed",
    data: {
      object: {
        id: over.sessionId ?? `cs_${randomUUID()}`,
        payment_status: over.paid ?? "paid",
        currency: over.currency ?? "usd",
        amount_total: over.amount ?? 2500,
        metadata: { fan_id: over.fanId },
      },
    },
  } as unknown as Stripe.Event;
}

describe("startTopup", () => {
  test("an amount outside the presets and the custom bounds, or not whole cents, is refused before Stripe is called", async () => {
    const fan = await makeFan();
    const createTopupSession = vi.fn();
    const provider = { createTopupSession } as unknown as StripeProvider;
    for (const amount of [0, -1000, 499, 50001, 1000.5, 600.25, Number.NaN]) {
      await expect(startTopup(fan.id, amount, "http://x.test", provider)).rejects.toBeInstanceOf(InvalidAmount);
    }
    expect(createTopupSession).not.toHaveBeenCalled();
  });

  test("custom amounts: 500 and 50000 are accepted, 499 and 50001 are not", async () => {
    const fan = await makeFan();
    const createTopupSession = vi.fn().mockResolvedValue({ id: "cs_1", url: "https://stripe.test/pay" });
    const provider = { createTopupSession } as unknown as StripeProvider;
    for (const amount of [500, 1234, 50000]) await startTopup(fan.id, amount, "http://x.test", provider);
    expect(createTopupSession.mock.calls.map((c) => c[0].amountCents)).toEqual([500, 1234, 50000]);
    for (const amount of [499, 50001]) {
      await expect(startTopup(fan.id, amount, "http://x.test", provider)).rejects.toBeInstanceOf(InvalidAmount);
    }
    expect(createTopupSession).toHaveBeenCalledTimes(3);
  });

  test("a configured amount creates a session for this fan", async () => {
    const fan = await makeFan();
    const createTopupSession = vi.fn().mockResolvedValue({ id: "cs_1", url: "https://stripe.test/pay" });
    const provider = { createTopupSession } as unknown as StripeProvider;
    const res = await startTopup(fan.id, 2500, "http://x.test", provider);
    expect(res.url).toBe("https://stripe.test/pay");
    expect(createTopupSession).toHaveBeenCalledWith(
      expect.objectContaining({ fanId: fan.id, amountCents: 2500 }),
    );
  });
});

describe("applyCheckoutEvent", () => {
  test("the same event applied twice credits once, with Stripe's amount", async () => {
    const fan = await makeFan();
    const event = completed({ fanId: fan.id, amount: 5000 });
    expect(await applyCheckoutEvent(event)).toBe("credited");
    expect(await applyCheckoutEvent(event)).toBe("duplicate");
    const rows = await db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, fan.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "topup", amountCents: 5000, stripeEventId: event.id });
    expect(await balanceOf(fan.id)).toBe(5000);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("another event type is ignored and records nothing", async () => {
    const fan = await makeFan();
    expect(await applyCheckoutEvent(completed({ fanId: fan.id, type: "checkout.session.expired" }))).toBe("ignored");
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, fan.id))).toHaveLength(0);
    expect(await db.select().from(uncreditedPayments).where(eq(uncreditedPayments.fanId, fan.id))).toHaveLength(0);
  });

  test("paid_session_for_flagged_fan_writes_uncredited_row_and_no_credit", async () => {
    const fan = await makeFan();
    await db.update(users).set({ flaggedAt: new Date() }).where(eq(users.id, fan.id));
    const event = completed({ fanId: fan.id, amount: 2500, sessionId: "cs_flagged" });
    expect(await applyCheckoutEvent(event)).toBe("uncredited");
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, fan.id))).toHaveLength(0);
    const rows = await db.select().from(uncreditedPayments).where(eq(uncreditedPayments.stripeEventId, event.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reason: "flagged_fan",
      fanId: fan.id,
      stripeSessionId: "cs_flagged",
      amountCents: 2500,
      currency: "usd",
      resolvedAt: null,
    });
    // The admin read lists it, and a redelivery does not add a second row.
    expect((await listOpenUncredited(500)).map((r) => r.stripeEventId)).toContain(event.id);
    expect(await applyCheckoutEvent(event)).toBe("uncredited");
    expect(await db.select().from(uncreditedPayments).where(eq(uncreditedPayments.stripeEventId, event.id))).toHaveLength(1);
  });

  test("non_usd_session_writes_uncredited_row", async () => {
    const fan = await makeFan();
    const event = completed({ fanId: fan.id, currency: "eur", amount: 3000 });
    expect(await applyCheckoutEvent(event)).toBe("uncredited");
    const [row] = await db.select().from(uncreditedPayments).where(eq(uncreditedPayments.stripeEventId, event.id));
    expect(row).toMatchObject({ reason: "non_usd", currency: "eur", amountCents: 3000 });
    expect(await balanceOf(fan.id)).toBe(0);
  });

  test("every uncredited cause records its reason and no credit", async () => {
    const flagged = await makeFan();
    const cases: { name: string; event: Stripe.Event; reason: string }[] = [
      { name: "unpaid", event: completed({ fanId: (await makeFan()).id, paid: "unpaid" }), reason: "unpaid" },
      { name: "zero", event: completed({ fanId: (await makeFan()).id, amount: 0 }), reason: "bad_amount" },
      { name: "no fan", event: completed({ fanId: undefined }), reason: "missing_fan" },
      { name: "malformed fan", event: completed({ fanId: "not-a-uuid" }), reason: "missing_fan" },
      { name: "unknown fan", event: completed({ fanId: randomUUID() }), reason: "unknown_fan" },
    ];
    expect(flagged.id).toBeTruthy();
    for (const c of cases) {
      expect(await applyCheckoutEvent(c.event), c.name).toBe("uncredited");
      const [row] = await db.select().from(uncreditedPayments).where(eq(uncreditedPayments.stripeEventId, c.event.id));
      expect(row?.reason, c.name).toBe(c.reason);
    }
    // A malformed fan id is never stored in the uuid column.
    const [malformed] = await db.select().from(uncreditedPayments).where(eq(uncreditedPayments.stripeEventId, cases[3].event.id));
    expect(malformed.fanId).toBeNull();
  });

  test("two_event_ids_one_session_credit_once", async () => {
    const fan = await makeFan();
    const first = completed({ fanId: fan.id, amount: 5000, sessionId: "cs_same" });
    const second = completed({ fanId: fan.id, amount: 5000, sessionId: "cs_same", type: "checkout.session.async_payment_succeeded" });
    expect(first.id).not.toBe(second.id);
    expect(await applyCheckoutEvent(first)).toBe("credited");
    expect(await applyCheckoutEvent(second)).toBe("duplicate");
    const rows = await db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, fan.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].stripeSessionId).toBe("cs_same");
    expect(await balanceOf(fan.id)).toBe(5000);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("the same session delivered as completed and async_payment_succeeded at once credits once", async () => {
    const fan = await makeFan();
    const events = Array.from({ length: 6 }, (_, i) =>
      completed({
        fanId: fan.id,
        amount: 2500,
        sessionId: "cs_race",
        type: i % 2 ? "checkout.session.async_payment_succeeded" : "checkout.session.completed",
      }),
    );
    const results = await Promise.all(events.map((e) => applyCheckoutEvent(e)));
    expect(results.filter((r) => r === "credited")).toHaveLength(1);
    expect(results.filter((r) => r === "duplicate")).toHaveLength(5);
    expect(await balanceOf(fan.id)).toBe(2500);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("async_payment_succeeded_credits_once", async () => {
    const fan = await makeFan();
    const event = completed({ fanId: fan.id, amount: 1000, type: "checkout.session.async_payment_succeeded" });
    expect(await applyCheckoutEvent(event)).toBe("credited");
    expect(await applyCheckoutEvent(event)).toBe("duplicate");
    expect(await balanceOf(fan.id)).toBe(1000);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("an unpaid completed session is resolved when its async payment later succeeds", async () => {
    const fan = await makeFan();
    const unpaid = completed({ fanId: fan.id, paid: "unpaid", sessionId: "cs_async" });
    expect(await applyCheckoutEvent(unpaid)).toBe("uncredited");
    const paid = completed({ fanId: fan.id, sessionId: "cs_async", type: "checkout.session.async_payment_succeeded" });
    expect(await applyCheckoutEvent(paid)).toBe("credited");
    const [row] = await db.select().from(uncreditedPayments).where(eq(uncreditedPayments.stripeEventId, unpaid.id));
    expect(row.resolvedAt).not.toBeNull();
    expect((await listOpenUncredited(500)).map((r) => r.id)).not.toContain(row.id);
  });

  test("async_payment_failed_writes_uncredited", async () => {
    const fan = await makeFan();
    const event = completed({ fanId: fan.id, paid: "unpaid", type: "checkout.session.async_payment_failed" });
    expect(await applyCheckoutEvent(event)).toBe("uncredited");
    expect(await applyCheckoutEvent(event)).toBe("uncredited");
    const rows = await db.select().from(uncreditedPayments).where(eq(uncreditedPayments.stripeEventId, event.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("async_failed");
    expect(await balanceOf(fan.id)).toBe(0);
  });

  test("resolveUncredited closes an open row once", async () => {
    const event = completed({ fanId: randomUUID() });
    await applyCheckoutEvent(event);
    const [row] = await db.select().from(uncreditedPayments).where(eq(uncreditedPayments.stripeEventId, event.id));
    expect(await resolveUncredited(row.id, new Date("2026-11-03T12:00:00Z"))).toBe(true);
    expect(await resolveUncredited(row.id, new Date("2026-11-03T13:00:00Z"))).toBe(false);
    const [after] = await db.select().from(uncreditedPayments).where(eq(uncreditedPayments.id, row.id));
    expect(after.resolvedAt?.toISOString()).toBe("2026-11-03T12:00:00.000Z");
  });
});

function succeeded(over: { id?: string; fanId?: string; amount?: number; purpose?: string | null; currency?: string }): Stripe.Event {
  return {
    id: over.id ?? `evt_${randomUUID()}`,
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: `pi_${randomUUID()}`,
        currency: over.currency ?? "usd",
        amount_received: over.amount ?? 2500,
        metadata: { fan_id: over.fanId, ...(over.purpose === null ? {} : { purpose: over.purpose ?? "wallet_topup" }) },
      },
    },
  } as unknown as Stripe.Event;
}

describe("startTopupIntent", () => {
  test("an out-of-bounds amount is refused before Stripe is called; a valid one creates the intent for this fan", async () => {
    const fan = await makeFan();
    const createTopupIntent = vi.fn().mockResolvedValue({ id: "pi_1", status: "succeeded" });
    const provider = { createTopupIntent } as unknown as StripeProvider;
    for (const amount of [0, 499, 50001, 1000.5]) {
      await expect(startTopupIntent(fan.id, amount, "pm_card_visa", provider)).rejects.toBeInstanceOf(InvalidAmount);
    }
    expect(createTopupIntent).not.toHaveBeenCalled();
    await startTopupIntent(fan.id, 2500, "pm_card_visa", provider);
    expect(createTopupIntent).toHaveBeenCalledWith({ fanId: fan.id, amountCents: 2500, paymentMethod: "pm_card_visa" });
  });
});

describe("applyPaymentIntentSucceeded", () => {
  test("payment_intent_succeeded_credits_once", async () => {
    const fan = await makeFan();
    const event = succeeded({ fanId: fan.id, amount: 1500 });
    expect(await applyPaymentIntentSucceeded(event)).toBe("credited");
    const rows = await db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, fan.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "topup", amountCents: 1500, stripeEventId: event.id });
    expect(await balanceOf(fan.id)).toBe(1500);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("redelivery_is_duplicate", async () => {
    const fan = await makeFan();
    const event = succeeded({ fanId: fan.id });
    expect(await applyPaymentIntentSucceeded(event)).toBe("credited");
    expect(await applyPaymentIntentSucceeded(event)).toBe("duplicate");
    expect(await balanceOf(fan.id)).toBe(2500);
  });

  test("wrong_purpose_or_currency_ignored", async () => {
    const fan = await makeFan();
    for (const over of [{ purpose: null }, { purpose: "something_else" }, { currency: "eur" }, { amount: 0 }]) {
      expect(await applyPaymentIntentSucceeded(succeeded({ fanId: fan.id, ...over }))).toBe("ignored");
    }
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, fan.id))).toHaveLength(0);
  });

  test("flagged_fan_ignored", async () => {
    const flagged = await makeFan();
    await db.update(users).set({ flaggedAt: new Date() }).where(eq(users.id, flagged.id));
    for (const fanId of [undefined, "not-a-uuid", randomUUID(), flagged.id]) {
      expect(await applyPaymentIntentSucceeded(succeeded({ fanId }))).toBe("ignored");
    }
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, flagged.id))).toHaveLength(0);
  });
});
