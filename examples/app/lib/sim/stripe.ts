import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "@/db/client";
import { wallets } from "@/db/schema";
import { getConfig } from "@/lib/config";
import { applyPaymentIntentSucceeded, startTopupIntent } from "@/lib/wallet/topup";
import { stripeProvider, type StripeProvider } from "@/providers/stripe";

export type TopupResult = { ok: true; balanceCents: number } | { ok: false; code: "webhook_timeout" | "stripe_error" | "invalid_amount" };

/** How a sim fan tops up. Production goes through Stripe test mode and the signed webhook; tests use the fake. */
export interface SimStripe {
  topup(fanId: string, cents: number): Promise<TopupResult>;
}

async function balanceOf(fanId: string): Promise<number> {
  const [w] = await db.select({ b: wallets.balanceCents }).from(wallets).where(eq(wallets.fanId, fanId));
  return w?.b ?? 0;
}

/**
 * Creates a confirmed PaymentIntent with the configured test card, then waits for the signed `payment_intent.succeeded`
 * webhook (delivered by `stripe listen` or the deployed endpoint) to credit the wallet. The sim never credits it itself.
 */
export class LiveSimStripe implements SimStripe {
  constructor(
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly provider: () => StripeProvider = stripeProvider,
  ) {}

  async topup(fanId: string, cents: number): Promise<TopupResult> {
    const [method, waitMs] = await Promise.all([getConfig<string>("sim.topup_payment_method"), getConfig<number>("sim.webhook_wait_ms")]);
    const before = await balanceOf(fanId);
    try {
      await startTopupIntent(fanId, cents, method, this.provider());
    } catch (e) {
      return { ok: false, code: (e as Error).name === "InvalidAmount" ? "invalid_amount" : "stripe_error" };
    }
    const deadline = Date.now() + waitMs;
    for (;;) {
      const now = await balanceOf(fanId);
      if (now >= before + cents) return { ok: true, balanceCents: now };
      if (Date.now() >= deadline) return { ok: false, code: "webhook_timeout" };
      await this.sleep(500);
    }
  }
}

/** Test double: applies the same handler the webhook route calls, with a synthetic event, so the credit path is the real one. */
export class FakeSimStripe implements SimStripe {
  readonly calls: { fanId: string; cents: number }[] = [];
  private n = 0;

  async topup(fanId: string, cents: number): Promise<TopupResult> {
    this.calls.push({ fanId, cents });
    const event = {
      id: `evt_sim_${fanId}_${this.n++}`,
      type: "payment_intent.succeeded",
      data: { object: { id: `pi_sim_${this.n}`, currency: "usd", amount_received: cents, metadata: { fan_id: fanId, purpose: "wallet_topup" } } },
    } as unknown as Stripe.Event;
    const outcome = await applyPaymentIntentSucceeded(event);
    return outcome === "ignored" ? { ok: false, code: "stripe_error" } : { ok: true, balanceCents: await balanceOf(fanId) };
  }
}
