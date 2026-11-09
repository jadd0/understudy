import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { expect } from "vitest";
import { db, withTx } from "@/db/client";
import { catalogueItems, config, conversations, creators, offers, users, wallets } from "@/db/schema";
import { credit, ledgerSum } from "@/lib/wallet/ledger";
import { makeUser } from "@/db/test-helpers";

export const CAP = 20000;

export async function makeFan() {
  return makeUser({ role: "fan", adultConfirmedAt: new Date("2026-01-01T00:00:00Z") });
}

export async function makeCreator() {
  const user = await makeUser({ role: "creator" });
  const [creator] = await db
    .insert(creators)
    .values({ userId: user.id, handle: `h-${randomUUID().slice(0, 8)}`, displayName: "Test" })
    .returning();
  return creator;
}

/** Credits the fan through the real primitive so the ledger and the balance agree from the start. */
export async function fund(fanId: string, amountCents: number) {
  await withTx((tx) => credit(tx, { fanId, kind: "topup", amountCents, stripeEventId: `evt_${randomUUID()}` }));
}

export async function makeItem(creatorId: string, priceCents: number) {
  const [item] = await db
    .insert(catalogueItems)
    .values({ creatorId, kind: "ppv", title: "Test item", priceCents })
    .returning();
  return item;
}

export async function makeConversation(creatorId: string, fanId: string) {
  const [conv] = await db.insert(conversations).values({ creatorId, fanId }).returning();
  return conv;
}

/** Offer rows are written directly: creating offers belongs to the engine. Expiry is relative to the database clock. */
export async function makeOffer(
  conversationId: string,
  itemId: string,
  priceCents: number,
  over: { status?: "open" | "accepted" | "declined" | "expired"; expiresInSeconds?: number } = {},
) {
  const seconds = over.expiresInSeconds ?? 3600;
  const [offer] = await db
    .insert(offers)
    .values({
      conversationId,
      itemId,
      priceCents,
      status: over.status ?? "open",
      expiresAt: sql`now() + make_interval(secs => ${seconds})`,
    })
    .returning();
  return offer;
}

/** Wallet balance must equal the ledger sum, and never be negative. */
export async function assertBalanceEqualsLedger(fanId: string) {
  const [wallet] = await db.select().from(wallets).where(eq(wallets.fanId, fanId));
  const sum = await withTx((tx) => ledgerSum(tx, fanId));
  expect(wallet?.balanceCents ?? 0).toBe(sum);
  expect(sum).toBeGreaterThanOrEqual(0);
}

export async function balanceOf(fanId: string) {
  const [wallet] = await db.select().from(wallets).where(eq(wallets.fanId, fanId));
  return wallet?.balanceCents ?? 0;
}

export { users };

export const DEFAULT_CONFIG: Record<string, unknown> = {
  "wallet.topup_options_cents": [1000, 2500, 5000],
  "wallet.topup_min_cents": 500,
  "wallet.topup_max_cents": 50000,
  "wallet.welcome_credit_cents": 5000,
  "wallet.cap_min_cents": 500,
  "wallet.cap_raise_delay_hours": 24,
  "wallet.daily_cap_cents": CAP,
  "cap.max_daily_cents": 100000,
  "fan.high_value_threshold_cents": 10000,
  "fan.high_value_half_life_days": 7,
  "offer.ttl_minutes": 1440,
};

/** Platform config rows (creator_id null); overwrites so each test file controls its own numbers. */
export async function setConfig(over: Record<string, unknown> = {}) {
  for (const [key, value] of Object.entries({ ...DEFAULT_CONFIG, ...over })) {
    await db
      .insert(config)
      .values({ key, value })
      .onConflictDoUpdate({ target: [config.key, config.creatorId], set: { value } });
  }
}
