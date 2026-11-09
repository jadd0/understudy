import { sql } from "drizzle-orm";
import { db, type Tx } from "@/db/client";
import { answerOf, DeciderUnavailable, type Decider, type DeciderState } from "@/platform/ports/decider";
import type { HostPort, ShortlistItem } from "./host";
import { offerPickQuestion } from "./questions";

export type { ShortlistItem };

/**
 * Items the fan already owns, for when he owns everything else on the shortlist's terms: the same kinds and order,
 * active, and not the subject of an open offer here. Unlocking one again charges its price like any purchase
 * (`unlockOffer`), so the caller applies the same cap filter as to the unowned shortlist.
 */
export const buildOwnedShortlist = (
  host: HostPort,
  creatorId: string,
  fanId: string,
  conversationId: string,
  kinds?: ShortlistItem["kind"][],
): Promise<ShortlistItem[]> => host.catalogue.ownedShortlist({ creatorId, fanId, conversationId, kinds });

/**
 * Whether the fan owns every active ppv and bundle item the creator lists (and at least one): the AI can offer him
 * nothing new. The personal chat is never AI-offered, so it does not count.
 */
export const ownsEverything = (host: HostPort, creatorId: string, fanId: string): Promise<boolean> =>
  host.catalogue.ownsEverything(creatorId, fanId);

/**
 * The items the AI may offer: the creator's active ones, not already unlocked by the fan, and not the subject
 * of an open unexpired offer in this conversation. Built by code, in a fixed order, so the model only ever picks.
 */
export const buildShortlist = (
  host: HostPort,
  creatorId: string,
  fanId: string,
  conversationId: string,
  kinds?: ShortlistItem["kind"][],
): Promise<ShortlistItem[]> => host.catalogue.shortlist({ creatorId, fanId, conversationId, kinds });

/**
 * Jev picks from the shortlist; it sees keys, titles and teasers, never prices. A single candidate needs no
 * call. A key outside the shortlist is `DeciderUnavailable("malformed")`, which the caller turns into a plain reply.
 */
export async function pickOffer(
  decider: Decider,
  shortlist: ShortlistItem[],
  state: DeciderState,
): Promise<{ item: ShortlistItem; usage: { inputTokens: number; outputTokens: number } | null; model: string | null; answer: string | null }> {
  if (shortlist.length === 0) throw new DeciderUnavailable("malformed");
  if (shortlist.length === 1) return { item: shortlist[0], usage: null, model: null, answer: null };
  const result = await decider.ask([offerPickQuestion(shortlist)], { state });
  const value = answerOf(result, "offer_pick").value;
  const match = /^o(\d+)$/.exec(value);
  const item = match ? shortlist[Number(match[1]) - 1] : undefined;
  if (!item) throw new DeciderUnavailable("malformed");
  return { item, usage: result.usage, model: result.model, answer: value };
}

/** The conversation's open unexpired offer, if any (expired ones are treated as expired on read). */
export async function openOfferId(conversationId: string): Promise<string | null> {
  const { rows } = await db.execute(sql`
    select id from offers
    where conversation_id = ${conversationId} and status = 'open' and expires_at > now()
    order by created_at desc limit 1`);
  return (rows[0] as { id: string } | undefined)?.id ?? null;
}

/** Marks a declined offer. Runs in the commit transaction; a no-op if the fan unlocked it in the meantime. */
export async function declineOffer(tx: Tx, offerId: string): Promise<void> {
  await tx.execute(sql`update offers set status = 'declined', resolved_at = now() where id = ${offerId} and status = 'open'`);
}

/** Open offers past their expiry become `expired`. Idempotent; returns how many were marked. */
export async function expireOffers(): Promise<number> {
  const { rows } = await db.execute(sql`
    update offers set status = 'expired', resolved_at = now()
    where status = 'open' and expires_at <= now() returning id`);
  return rows.length;
}
