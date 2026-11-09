import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { ledgerEntries } from "@/db/schema";
import type { StripeProvider } from "@/providers/stripe";
import { applyPaymentIntentSucceeded } from "@/lib/wallet/topup";
import { assertBalanceEqualsLedger, makeFan } from "@/lib/wallet/test-helpers";
import { LiveSimStripe } from "./stripe";
import { setSimConfig } from "./test-helpers";
import type Stripe from "stripe";

const event = (fanId: string, cents: number): Stripe.Event =>
  ({ id: `evt_live_${fanId}`, type: "payment_intent.succeeded", data: { object: { id: "pi_x", currency: "usd", amount_received: cents, metadata: { fan_id: fanId, purpose: "wallet_topup" } } } }) as unknown as Stripe.Event;

describe("LiveSimStripe", () => {
  test("the sim creates the PaymentIntent and waits for the webhook to credit the wallet", async () => {
    await setSimConfig({ "sim.webhook_wait_ms": 5000 });
    const fan = await makeFan();
    const created: unknown[] = [];
    const provider = { createTopupIntent: async (i: unknown) => (created.push(i), { id: "pi_x", status: "succeeded" }) } as unknown as StripeProvider;
    let polls = 0;
    // the "webhook" lands on the second poll, through the same handler the signed route calls
    const stripe = new LiveSimStripe(async () => {
      if (++polls === 2) await applyPaymentIntentSucceeded(event(fan.id, 2500));
    }, () => provider);
    const out = await stripe.topup(fan.id, 2500);
    expect(out).toEqual({ ok: true, balanceCents: 2500 });
    expect(created).toEqual([{ fanId: fan.id, amountCents: 2500, paymentMethod: "pm_card_visa" }]);
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, fan.id))).toHaveLength(1);
    await assertBalanceEqualsLedger(fan.id);
  });

  test("no webhook within sim.webhook_wait_ms is a failed beat, and nothing is credited by the sim itself", async () => {
    await setSimConfig({ "sim.webhook_wait_ms": 1 });
    const fan = await makeFan();
    const provider = { createTopupIntent: async () => ({ id: "pi_y", status: "succeeded" }) } as unknown as StripeProvider;
    const stripe = new LiveSimStripe(async () => {}, () => provider);
    expect(await stripe.topup(fan.id, 2500)).toEqual({ ok: false, code: "webhook_timeout" });
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, fan.id))).toHaveLength(0);
    await setSimConfig();
  });

  test("an amount the wallet would refuse never reaches Stripe", async () => {
    await setSimConfig();
    const fan = await makeFan();
    let called = false;
    const provider = { createTopupIntent: async () => ((called = true), { id: "pi", status: "succeeded" }) } as unknown as StripeProvider;
    expect(await new LiveSimStripe(async () => {}, () => provider).topup(fan.id, 7)).toEqual({ ok: false, code: "invalid_amount" });
    expect(called).toBe(false);
  });
});
