import { stripeProvider } from "@/providers/stripe";
import { applyCheckoutEvent, applyPaymentIntentSucceeded } from "@/lib/wallet/topup";

export const runtime = "nodejs";

/** Stripe calls this. The raw body is verified against the signature before anything is read from it. */
export async function POST(req: Request) {
  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("missing signature", { status: 400 });
  const raw = await req.text();

  let event;
  try {
    event = stripeProvider().constructEvent(raw, signature);
  } catch (e) {
    console.error("stripe webhook: signature check failed", (e as Error).name);
    return new Response("bad signature", { status: 400 });
  }

  try {
    if (event.type === "payment_intent.succeeded") {
      const outcome = await applyPaymentIntentSucceeded(event);
      // Every Checkout-made PaymentIntent arrives here with no purpose; only one of ours that did not credit is news.
      const purpose = (event.data.object as { metadata?: { purpose?: string } }).metadata?.purpose;
      if (outcome === "ignored" && purpose === "wallet_topup") console.warn("stripe webhook: payment intent not credited", event.id);
      return new Response(null, { status: 200 });
    }
    const outcome = await applyCheckoutEvent(event);
    if (outcome === "uncredited") console.warn("stripe webhook: checkout event recorded as uncredited", event.id);
    return new Response(null, { status: 200 });
  } catch (e) {
    // A real failure: answer 500 so Stripe redelivers; the unique event id keeps the retry safe.
    console.error("stripe webhook: handler failed", (e as { code?: string }).code, (e as Error).name);
    return new Response("error", { status: 500 });
  }
}
