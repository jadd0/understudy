import { and, eq, isNull, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { db, withTx, type Tx } from "@/db/client";
import { uncreditedPayments, users } from "@/db/schema";
import { getConfig } from "@/lib/config";
import { stripeProvider, type StripeProvider } from "@/providers/stripe";
import { InvalidAmount } from "./errors";
import { credit } from "./ledger";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TopupOutcome = "credited" | "duplicate" | "uncredited" | "ignored";

/** Starts a Checkout session for a preset or a custom whole-cent amount within the configured bounds; refused before Stripe is called otherwise. */
export async function startTopup(
  fanId: string,
  amountCents: number,
  baseUrl: string,
  provider: StripeProvider = stripeProvider(),
  /** The handle of the chat the fan came from, already checked by the caller; the wallet's way back keeps it. */
  chatHandle?: string,
): Promise<{ id: string; url: string }> {
  await assertTopupAmount(amountCents);
  const chat = chatHandle ? `&c=${encodeURIComponent(chatHandle)}` : "";
  return provider.createTopupSession({
    fanId,
    amountCents,
    successUrl: `${baseUrl}/wallet?topup=processing${chat}`,
    cancelUrl: `${baseUrl}/wallet?topup=cancelled${chat}`,
  });
}

/** The same amount check `startTopup` makes, shared so both entry points refuse the same inputs. */
async function assertTopupAmount(amountCents: number): Promise<void> {
  const [presets, min, max] = await Promise.all([
    getConfig<number[]>("wallet.topup_options_cents"),
    getConfig<number>("wallet.topup_min_cents"),
    getConfig<number>("wallet.topup_max_cents"),
  ]);
  const allowed = presets.includes(amountCents) || (amountCents >= min && amountCents <= max);
  if (!Number.isSafeInteger(amountCents) || !allowed) throw new InvalidAmount();
}

/**
 * Starts a top-up with a saved card: a confirmed PaymentIntent whose signed `payment_intent.succeeded` webhook
 * credits the wallet. Validated like `startTopup`, and refused before Stripe is called otherwise.
 */
export async function startTopupIntent(
  fanId: string,
  amountCents: number,
  paymentMethod: string,
  provider: StripeProvider = stripeProvider(),
): Promise<{ id: string; status: string }> {
  await assertTopupAmount(amountCents);
  return provider.createTopupIntent({ fanId, amountCents, paymentMethod });
}

/**
 * Credits the wallet for a succeeded top-up PaymentIntent. Only an intent we created for a top-up
 * (`metadata.purpose`) in dollars counts; the amount is Stripe's `amount_received`. The event id is the ledger key, so a
 * redelivery is a no-op, and an unknown or flagged fan is ignored.
 */
export async function applyPaymentIntentSucceeded(event: Stripe.Event): Promise<TopupOutcome> {
  if (event.type !== "payment_intent.succeeded") return "ignored";
  const intent = event.data.object;
  if (intent.metadata?.purpose !== "wallet_topup" || intent.currency !== "usd") return "ignored";
  const fanId = intent.metadata?.fan_id;
  const amount = intent.amount_received;
  if (!fanId || !UUID.test(fanId) || !Number.isSafeInteger(amount) || !amount || amount <= 0) return "ignored";

  const [fan] = await db.select({ role: users.role, flaggedAt: users.flaggedAt }).from(users).where(eq(users.id, fanId));
  if (!fan || fan.role !== "fan" || fan.flaggedAt) return "ignored";

  const result = await withTx((tx) => credit(tx, { fanId, kind: "topup", amountCents: amount, stripeEventId: event.id }));
  return result.replayed ? "duplicate" : "credited";
}

type Reason = typeof uncreditedPayments.$inferInsert.reason;

const CHECKOUT_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
]);

/** Records a Checkout event that credited nobody. The unique event id makes a redelivery write nothing more. */
async function recordUncredited(
  tx: Tx,
  event: Stripe.Event,
  session: Stripe.Checkout.Session,
  reason: Reason,
): Promise<void> {
  const fanId = session.metadata?.fan_id;
  await tx
    .insert(uncreditedPayments)
    .values({
      stripeEventId: event.id,
      stripeSessionId: session.id,
      fanId: fanId && UUID.test(fanId) ? fanId : null,
      amountCents: Number.isSafeInteger(session.amount_total) ? session.amount_total : null,
      currency: session.currency,
      reason,
    })
    .onConflictDoNothing({ target: uncreditedPayments.stripeEventId });
}

/**
 * Applies a Checkout event. `completed` and `async_payment_succeeded` credit the wallet when the session is paid:
 * the amount is Stripe's `amount_total`, the fan is the session metadata, and the unique event id and the unique
 * session id each make a repeat a no-op, so one session credits once however many events carry it. A paid or
 * failed session that cannot credit is written to `uncredited_payments` for a person to refund in Stripe; the
 * webhook still answers 200 so Stripe does not retry forever. Events of other types are ignored.
 */
export async function applyCheckoutEvent(event: Stripe.Event): Promise<TopupOutcome> {
  if (!CHECKOUT_EVENTS.has(event.type)) return "ignored";
  const session = event.data.object as Stripe.Checkout.Session;

  if (event.type === "checkout.session.async_payment_failed") {
    await withTx((tx) => recordUncredited(tx, event, session, "async_failed"));
    return "uncredited";
  }

  const fanId = session.metadata?.fan_id;
  const amount = session.amount_total;
  let reason: Reason | null = null;
  if (session.payment_status !== "paid") reason = "unpaid";
  else if (session.currency !== "usd") reason = "non_usd";
  else if (!Number.isSafeInteger(amount) || !amount || amount <= 0) reason = "bad_amount";
  else if (!fanId || !UUID.test(fanId)) reason = "missing_fan";
  if (!reason) {
    const [fan] = await db
      .select({ role: users.role, flaggedAt: users.flaggedAt })
      .from(users)
      .where(eq(users.id, fanId!));
    if (!fan || fan.role !== "fan") reason = "unknown_fan";
    else if (fan.flaggedAt) reason = "flagged_fan";
  }
  if (reason) {
    await withTx((tx) => recordUncredited(tx, event, session, reason));
    return "uncredited";
  }

  return withTx(async (tx) => {
    const result = await credit(tx, {
      fanId: fanId!,
      kind: "topup",
      amountCents: amount!,
      stripeEventId: event.id,
      stripeSessionId: session.id,
    });
    // An earlier unpaid event for this session was waiting on this payment; it is no longer needing review.
    await tx
      .update(uncreditedPayments)
      .set({ resolvedAt: sql`now()` })
      .where(
        and(
          eq(uncreditedPayments.stripeSessionId, session.id),
          eq(uncreditedPayments.reason, "unpaid"),
          isNull(uncreditedPayments.resolvedAt),
        ),
      );
    return result.replayed ? "duplicate" : "credited";
  });
}
