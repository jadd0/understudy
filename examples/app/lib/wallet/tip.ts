import { and, eq } from "drizzle-orm";
import { withTx } from "@/db/client";
import { conversations, creators } from "@/db/schema";
import { getConfig } from "@/lib/config";
import { assertFanMaySpend } from "./eligibility";
import { InvalidAmount, NotFound } from "./errors";
import { debit, lockWallet, type LedgerResult } from "./ledger";

/**
 * Tips the creator. A retry with the same idempotency key returns the first result and charges nothing.
 * The fan must be an unflagged fan, the creator must exist, and a conversation id must be this fan's with this creator.
 */
export async function tip(
  fanId: string,
  creatorId: string,
  amountCents: number,
  idempotencyKey: string,
  conversationId?: string,
): Promise<LedgerResult> {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || !idempotencyKey) throw new InvalidAmount();
  const platformCapCents = await getConfig<number>("wallet.daily_cap_cents");
  return withTx(async (tx) => {
    // Lock order is conversation, then wallet, then user (AGENTS.md): the tip's ledger row references the
    // conversation, so its lock is taken first rather than by the foreign key after the wallet.
    if (conversationId) {
      const [conv] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.fanId, fanId),
            eq(conversations.creatorId, creatorId),
          ),
        )
        .for("share");
      if (!conv) throw new NotFound();
    }
    await lockWallet(tx, fanId);
    await assertFanMaySpend(tx, fanId);
    const [creator] = await tx.select({ id: creators.id }).from(creators).where(eq(creators.id, creatorId));
    if (!creator) throw new NotFound();
    return debit(tx, { fanId, kind: "tip", creatorId, amountCents, platformCapCents, idempotencyKey, conversationId });
  });
}
