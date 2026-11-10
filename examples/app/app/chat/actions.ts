"use server";

import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { conversations } from "@/db/schema";
import { getConfig } from "@/lib/config";
import { formatCents } from "@/lib/wallet/money";
import { InvalidAmount } from "@/lib/wallet/errors";
import { markFanTyping } from "@/lib/chat/typing";
import { getEvents } from "@/lib/conversations/events";
import { requireAdultFan, requireChatReader } from "@/lib/auth/guards";
import { SendRefused, sendFanMessage, type SendRefusedReason } from "@/lib/chat/send";
import { fanCreator, getFanSnapshot } from "@/lib/conversations/read";
import { getFanChanges, getFanOlderMessages } from "@/lib/conversations/paging";
import { windowRead } from "@/lib/conversations/result";
import { CapReached, InsufficientFunds, NotYourOffer, OfferUnavailable } from "@/lib/wallet/errors";
import { tipInChat, unlockInChat } from "@/lib/chat/react";
import type { ActionResult } from "@/components/chat/types";

// Each action below takes the handle of the creator the fan is talking to as its first argument, bound by the page
// from `/chat?c=<handle>` (null for the default creator). It only chooses whom the fan writes to: the fan, and so
// the conversation, always come from the session.

/** The fan's own thread, found from the session: no conversation id is ever taken from the client. */
export async function refreshChat(handle: string | null) {
  const user = await requireChatReader();
  const found = await getFanSnapshot(user!.id!, handle);
  if (!found) throw new Error("no creator");
  return found.snapshot;
}

/** The page of the fan's own thread before `before`; the conversation comes from the session. */
export async function olderChat(handle: string | null, before: string) {
  const user = await requireChatReader();
  return windowRead(() => getFanOlderMessages(user!.id!, handle, before));
}

/** What changed in the fan's own thread since `since`; the conversation comes from the session. */
export async function chatChanges(handle: string | null, since: string) {
  const user = await requireChatReader();
  return windowRead(() => getFanChanges(user!.id!, handle, since));
}

// Typed by the reason list, so a new refusal reason cannot reach the fan as an empty error.
const REFUSALS: Record<SendRefusedReason, string> = {
  empty: "Type a message first.",
  too_long: "That message is too long.",
  not_a_fan: "This message could not be sent.",
  no_creator: "Nobody is here to message yet.",
  restricted: "Messaging is turned off for this account.",
  bad_id: "This message could not be sent.",
};

/** Saves the fan's message and schedules the engine's reply after the response. */
export async function sendMessage(handle: string | null, clientMsgId: string, body: string): Promise<ActionResult> {
  const user = await requireAdultFan();
  if (typeof clientMsgId !== "string" || clientMsgId.length < 8 || clientMsgId.length > 64 || typeof body !== "string") {
    return { ok: false, error: REFUSALS.empty };
  }
  const creator = await fanCreator(user!.id!, handle);
  if (!creator) return { ok: false, error: REFUSALS.no_creator };
  try {
    const sent = await sendFanMessage(user!.id!, creator.id, body, clientMsgId);
    if (!sent.duplicate) {
      const events = getEvents();
      // The conversation channel too: an admin holding the chat (`human_ts`) listens there, not on the creator's
      // channel, and the engine announces nothing while a human holds it, so his reply would otherwise not show.
      await Promise.allSettled([
        events.emit(`creator:${creator.id}`, "inbox.changed", { conversationId: sent.conversationId }),
        events.emit(`conversation:${sent.conversationId}`, "message.created", { messageId: sent.messageId, deliverInMs: 0 }),
      ]);
    }
    return { ok: true };
  } catch (e) {
    if (e instanceof SendRefused) return { ok: false, error: REFUSALS[e.code] };
    console.error("send failed", (e as Error).name);
    return { ok: false, error: "Something went wrong. Try again." };
  }
}

/** The fan's composer pings this while keys are pressed, so the engine waits for him to finish. Errors are ignored: it is a hint. */
export async function pingTyping(handle: string | null): Promise<void> {
  const user = await requireAdultFan();
  const creator = await fanCreator(user!.id!, handle);
  if (!creator) return;
  await markFanTyping(user!.id!, creator.id).catch(() => undefined);
}

/**
 * Spends from the fan's wallet on one of the fan's own offers; the ledger checks the offer belongs to them. A real
 * purchase schedules a turn in which she checks in about it.
 */
export async function unlockOfferAction(offerId: string): Promise<ActionResult> {
  const user = await requireAdultFan();
  if (typeof offerId !== "string") return { ok: false, error: "This offer is no longer available." };
  try {
    await unlockInChat(user!.id!, offerId);
    return { ok: true };
  } catch (e) {
    if (e instanceof InsufficientFunds) return { ok: false, error: "Your balance is too low. Top up in your wallet to unlock this." };
    if (e instanceof CapReached) return { ok: false, error: "That would pass your daily limit. Change it in your wallet." };
    if (e instanceof OfferUnavailable || e instanceof NotYourOffer) return { ok: false, error: "This offer is no longer available." };
    console.error("unlock failed", (e as Error).name);
    return { ok: false, error: "Something went wrong. Try again." };
  }
}

/**
 * Tips the creator from the fan's wallet inside the fan's own conversation (`tipInChat`): a system row ("You tipped
 * $5.00") both sides see, and a turn in which she thanks him in her own voice. The idempotency key comes from the
 * client, is scoped to the fan by the ledger, and also keys the row, so a retry charges, posts and thanks once.
 */
export async function tipAction(handle: string | null, idempotencyKey: string, amountCents: number): Promise<ActionResult> {
  const user = await requireAdultFan();
  const fanId = user!.id!;
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 64) {
    return { ok: false, error: "Something went wrong. Try again." };
  }
  const minCents = await getConfig<number>("wallet.tip_min_cents");
  if (!Number.isSafeInteger(amountCents) || amountCents < minCents) {
    return { ok: false, error: `The smallest tip is ${formatCents(minCents)}.` };
  }
  const creator = await fanCreator(user!.id!, handle);
  if (!creator) return { ok: false, error: REFUSALS.no_creator };
  const [conv] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.creatorId, creator.id), eq(conversations.fanId, fanId)));
  if (!conv) return { ok: false, error: "Say hi first, then you can tip." };
  try {
    const { messageId } = await tipInChat(fanId, creator.id, conv.id, amountCents, idempotencyKey);
    if (messageId) {
      const events = getEvents();
      await Promise.allSettled([
        events.emit(`conversation:${conv.id}`, "message.created", { messageId, deliverInMs: 0 }),
        events.emit(`creator:${creator.id}`, "inbox.changed", { conversationId: conv.id }),
      ]);
    }
    return { ok: true };
  } catch (e) {
    if (e instanceof InsufficientFunds) return { ok: false, error: "Your balance is too low. Top up in your wallet to tip." };
    if (e instanceof CapReached) return { ok: false, error: "That would pass your daily limit. Change it in your wallet." };
    if (e instanceof InvalidAmount) return { ok: false, error: "Enter a valid tip." };
    console.error("tip failed", (e as Error).name);
    return { ok: false, error: "Something went wrong. Try again." };
  }
}
