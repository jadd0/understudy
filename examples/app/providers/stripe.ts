import Stripe from "stripe";

export type TopupSessionInput = {
  fanId: string;
  amountCents: number;
  successUrl: string;
  cancelUrl: string;
};

export type TopupIntentInput = {
  fanId: string;
  amountCents: number;
  /** A Stripe test payment method id such as pm_card_visa. */
  paymentMethod: string;
};

/** The one place the Stripe SDK is touched. Tests pass a fake client or a fake provider. */
export type StripeProvider = {
  createTopupSession(input: TopupSessionInput): Promise<{ id: string; url: string }>;
  /** A confirmed card PaymentIntent: the "saved card" top-up. The wallet is credited by its signed `payment_intent.succeeded` webhook, not by this call. */
  createTopupIntent(input: TopupIntentInput): Promise<{ id: string; status: string }>;
  constructEvent(rawBody: string, signature: string): Stripe.Event;
};

export function createStripeProvider(
  client: Stripe = new Stripe(requiredEnv("STRIPE_SECRET_KEY")),
  webhookSecret: () => string = () => requiredEnv("STRIPE_WEBHOOK_SECRET"),
): StripeProvider {
  return {
    async createTopupSession({ fanId, amountCents, successUrl, cancelUrl }) {
      const session = await client.checkout.sessions.create({
        mode: "payment",
        client_reference_id: fanId,
        metadata: { fan_id: fanId },
        success_url: successUrl,
        cancel_url: cancelUrl,
        line_items: [
          {
            quantity: 1,
            price_data: { currency: "usd", unit_amount: amountCents, product_data: { name: "Wallet top-up" } },
          },
        ],
      });
      if (!session.url) throw new Error("stripe returned a session without a url");
      return { id: session.id, url: session.url };
    },
    async createTopupIntent({ fanId, amountCents, paymentMethod }) {
      const intent = await client.paymentIntents.create({
        amount: amountCents,
        currency: "usd",
        confirm: true,
        payment_method: paymentMethod,
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        metadata: { fan_id: fanId, purpose: "wallet_topup" },
      });
      return { id: intent.id, status: intent.status };
    },
    constructEvent(rawBody, signature) {
      return client.webhooks.constructEvent(rawBody, signature, webhookSecret());
    },
  };
}

let shared: StripeProvider | undefined;

/** Built from the environment on first use, so importing this module needs no keys. */
export function stripeProvider(): StripeProvider {
  return (shared ??= createStripeProvider());
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
