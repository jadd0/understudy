import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { StripeNotConfigured } from "@/providers/stripe";
import { startTopup, startTopupIntent } from "@/lib/wallet/topup";

const saved = { ...process.env };
beforeEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
});
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

describe("top-ups without Stripe", () => {
  test("a hosted top-up is refused before any Stripe or config call", async () => {
    await expect(startTopup("fan", 1000, "http://x.test")).rejects.toBeInstanceOf(StripeNotConfigured);
  });

  test("a saved-card top-up is refused the same way", async () => {
    await expect(startTopupIntent("fan", 1000, "pm_card_visa")).rejects.toBeInstanceOf(StripeNotConfigured);
  });

  test("with only one of the two keys it is still off", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    await expect(startTopup("fan", 1000, "http://x.test")).rejects.toBeInstanceOf(StripeNotConfigured);
  });
});
