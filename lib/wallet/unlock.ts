import { eq, sql } from "drizzle-orm";
import { withTx } from "@/db/client";
import { conversations, offers, unlocks } from "@/db/schema";
import { getConfig } from "@/lib/config";
import { NotYourOffer, OfferUnavailable } from "./errors";
import { assertFanMaySpend } from "./eligibility";
import { debit, lockWallet } from "./ledger";

export type UnlockResult =
  | { alreadyUnlocked: true; itemId: string; conversationId: string }
  | { alreadyUnlocked: false; itemId: string; conversationId: string; ledgerEntryId: string; balanceCents: number };

/**
 * Redeems an offer for the fan. Locks in the platform order (AGENTS.md): conversation (share), offer, wallet, then
 * the user (share), so a hard stop or a takeover on the same conversation waits for it or it waits for them, and
 * neither can deadlock against it. The offer's own copied price is charged,
 * not the catalogue's. Every open, live offer is a purchase, including a re-offer of an item the fan already owns:
 * that is charged again, so each purchase is its own ledger entry while ownership stays one `unlocks` row. Only a
 * repeat of an offer that is already `accepted` (a retry or a double tap) returns `alreadyUnlocked` and charges nothing.
 * A flagged account or a non-fan is refused with `NotAllowed`.
 */
export async function unlockOffer(fanId: string, offerId: string): Promise<UnlockResult> {
  // Config is read before the transaction: a transaction that waits for a second pooled connection can deadlock the pool.
  const platformCapCents = await getConfig<number>("wallet.daily_cap_cents");

  return withTx(async (tx) => {
    // An offer never moves conversation, so its conversation can be read before any lock is taken.
    const [ref] = await tx.select({ conversationId: offers.conversationId }).from(offers).where(eq(offers.id, offerId));
    if (!ref) throw new OfferUnavailable();
    await tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, ref.conversationId)).for("share");

    const [offer] = await tx
      .select({
        itemId: offers.itemId,
        priceCents: offers.priceCents,
        status: offers.status,
        live: sql<boolean>`${offers.expiresAt} > now()`,
        fanId: conversations.fanId,
        creatorId: conversations.creatorId,
        conversationId: conversations.id,
      })
      .from(offers)
      .innerJoin(conversations, eq(conversations.id, offers.conversationId))
      .where(eq(offers.id, offerId))
      .for("update", { of: offers });
    if (!offer) throw new OfferUnavailable();
    if (offer.fanId !== fanId) throw new NotYourOffer();

    await lockWallet(tx, fanId);
    await assertFanMaySpend(tx, fanId);
    // This offer was already bought: a retry or a second tap. The offer row lock above makes a concurrent repeat
    // wait for the first and then read `accepted`, so it lands here and charges nothing.
    if (offer.status === "accepted") {
      return { alreadyUnlocked: true, itemId: offer.itemId, conversationId: offer.conversationId };
    }

    if (offer.status !== "open" || !offer.live) throw new OfferUnavailable();

    const paid = await debit(tx, {
      fanId,
      kind: "unlock",
      creatorId: offer.creatorId,
      amountCents: offer.priceCents,
      platformCapCents,
      offerId,
      conversationId: offer.conversationId,
    });
    // The ledger entry id is required by the unlock row, so the debit comes first. A re-purchase of an item he
    // already owns keeps the existing row (it points at the first purchase); the new ledger entry records this one.
    await tx
      .insert(unlocks)
      .values({ fanId, itemId: offer.itemId, ledgerEntryId: paid.ledgerEntryId })
      .onConflictDoNothing({ target: [unlocks.fanId, unlocks.itemId] });
    await tx.update(offers).set({ status: "accepted", resolvedAt: sql`now()` }).where(eq(offers.id, offerId));
    return {
      alreadyUnlocked: false,
      itemId: offer.itemId,
      conversationId: offer.conversationId,
      ledgerEntryId: paid.ledgerEntryId,
      balanceCents: paid.balanceCents,
    };
  });
}
