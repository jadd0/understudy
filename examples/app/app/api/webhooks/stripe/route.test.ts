import { describe, expect, test, vi, beforeEach } from "vitest";
import Stripe from "stripe";

const applyCheckoutEvent = vi.fn();
const applyPaymentIntentSucceeded = vi.fn();
vi.mock("@/lib/wallet/topup", () => ({ applyCheckoutEvent, applyPaymentIntentSucceeded }));

const SECRET = "whsec_test_secret";
const OTHER = "whsec_other_endpoint";
const stripe = new Stripe("sk_test_unused");

const body = (type: string) =>
  JSON.stringify({ id: "evt_1", object: "event", type, data: { object: { id: "cs_1" } } });
const payload = body("checkout.session.completed");
const sign = (secret: string, p = payload) => stripe.webhooks.generateTestHeaderString({ payload: p, secret });
const post = async (headers: Record<string, string>, p = payload) => {
  const { POST } = await import("@/app/api/webhooks/stripe/route");
  return POST(new Request("http://x.test/api/webhooks/stripe", { method: "POST", body: p, headers }));
};

beforeEach(() => {
  applyCheckoutEvent.mockReset();
  applyPaymentIntentSucceeded.mockReset();
  process.env.STRIPE_SECRET_KEY = "sk_test_unused";
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
});

describe("stripe webhook route", () => {
  test("a missing signature is 400 and never reaches the handler", async () => {
    expect((await post({})).status).toBe(400);
    expect(applyCheckoutEvent).not.toHaveBeenCalled();
  });

  test("a bad signature is 400 and never reaches the handler", async () => {
    expect((await post({ "stripe-signature": "t=1,v1=deadbeef" })).status).toBe(400);
    expect(applyCheckoutEvent).not.toHaveBeenCalled();
  });

  test("a valid signature for a different endpoint secret is 400", async () => {
    expect((await post({ "stripe-signature": sign(OTHER) })).status).toBe(400);
    expect(applyCheckoutEvent).not.toHaveBeenCalled();
  });

  test("a good signature calls the handler once and answers 200", async () => {
    applyCheckoutEvent.mockResolvedValue("credited");
    expect((await post({ "stripe-signature": sign(SECRET) })).status).toBe(200);
    expect(applyCheckoutEvent).toHaveBeenCalledTimes(1);
    expect(applyCheckoutEvent.mock.calls[0][0]).toMatchObject({ id: "evt_1" });
  });

  test("the async payment events reach the handler", async () => {
    applyCheckoutEvent.mockResolvedValue("credited");
    const types = ["checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed"];
    for (const type of types) {
      const p = body(type);
      expect((await post({ "stripe-signature": sign(SECRET, p) }, p)).status).toBe(200);
    }
    expect(applyCheckoutEvent.mock.calls.map((c) => c[0].type)).toEqual(types);
  });

  test("an uncredited outcome is 200 so Stripe does not retry", async () => {
    applyCheckoutEvent.mockResolvedValue("uncredited");
    expect((await post({ "stripe-signature": sign(SECRET) })).status).toBe(200);
  });

  test("a replay (duplicate) and an ignored event are both 200", async () => {
    for (const outcome of ["duplicate", "ignored"]) {
      applyCheckoutEvent.mockResolvedValue(outcome);
      expect((await post({ "stripe-signature": sign(SECRET) })).status).toBe(200);
    }
  });

  test("a handler failure is 500 so Stripe redelivers", async () => {
    applyCheckoutEvent.mockRejectedValue(new Error("db down"));
    expect((await post({ "stripe-signature": sign(SECRET) })).status).toBe(500);
  });

  test("payment_intent_event_reaches_its_handler", async () => {
    const pi = body("payment_intent.succeeded");
    applyPaymentIntentSucceeded.mockResolvedValue("credited");
    expect((await post({ "stripe-signature": sign(SECRET, pi) }, pi)).status).toBe(200);
    expect(applyPaymentIntentSucceeded).toHaveBeenCalledTimes(1);
    expect(applyPaymentIntentSucceeded.mock.calls[0][0]).toMatchObject({ id: "evt_1", type: "payment_intent.succeeded" });
    expect(applyCheckoutEvent).not.toHaveBeenCalled();
  });

  test("an ignored payment intent warns only when it was one of our top-ups", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    applyPaymentIntentSucceeded.mockResolvedValue("ignored");
    const withMeta = (metadata: Record<string, string>) =>
      JSON.stringify({ id: "evt_pi2", object: "event", type: "payment_intent.succeeded", data: { object: { id: "pi_2", metadata } } });
    const bare = withMeta({});
    expect((await post({ "stripe-signature": sign(SECRET, bare) }, bare)).status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
    const ours = withMeta({ purpose: "wallet_topup" });
    expect((await post({ "stripe-signature": sign(SECRET, ours) }, ours)).status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
