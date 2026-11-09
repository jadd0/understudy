import { after } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { conversations, creators, messages, users } from "@/db/schema";
import { defaultDeps } from "@/lib/engine/deps";
import { processConversation } from "@/lib/engine/process";

/** A host page or route that calls `sendFanMessage` re-exports this as its `maxDuration` (seconds). */
export const ENGINE_MAX_DURATION_S = 60;

export const MAX_MESSAGE_CHARS = 2000;

export const MAX_CLIENT_MSG_ID_CHARS = 100;

/** Why a send was refused. `restricted` is a fan flagged `minor_in_chat`: they may read but not write. */
export const SEND_REFUSED_REASONS = ["empty", "too_long", "bad_id", "not_a_fan", "restricted", "no_creator"] as const;
export type SendRefusedReason = (typeof SEND_REFUSED_REASONS)[number];

export class SendRefused extends Error {
  constructor(public readonly code: SendRefusedReason) {
    super(`message refused: ${code}`);
    this.name = "SendRefused";
  }
}

export interface SendResult {
  conversationId: string;
  messageId: string;
  /** True when this client message id was already saved; nothing new was stored or scheduled. */
  duplicate: boolean;
}

/**
 * Saves a fan's message and schedules the engine to answer it after the response. `fanId` must come from the
 * session in the calling action, never from client input. Re-sending the same `clientMsgId` returns the saved
 * message. The message is stored even when a human or Trust & Safety owns the conversation; the engine's lease
 * refuses to answer it then.
 */
export async function sendFanMessage(
  fanId: string,
  creatorId: string,
  body: string,
  clientMsgId: string,
  schedule: (task: () => Promise<unknown>) => void = (task) => after(task),
): Promise<SendResult> {
  const text = body.trim();
  if (text.length === 0) throw new SendRefused("empty");
  if (text.length > MAX_MESSAGE_CHARS) throw new SendRefused("too_long");
  if (typeof clientMsgId !== "string" || clientMsgId.length === 0 || clientMsgId.length > MAX_CLIENT_MSG_ID_CHARS) {
    throw new SendRefused("bad_id");
  }

  const [fan] = await db.select().from(users).where(eq(users.id, fanId));
  if (!fan || fan.role !== "fan" || !fan.adultConfirmedAt) throw new SendRefused("not_a_fan");
  // A minor seen in chat may read but not write; any other flag (a ban, an under-18 date) is simply not a fan.
  if (fan.flaggedAt) throw new SendRefused(fan.flagReason === "minor_in_chat" ? "restricted" : "not_a_fan");
  const [creator] = await db.select({ id: creators.id }).from(creators).where(eq(creators.id, creatorId));
  if (!creator) throw new SendRefused("no_creator");

  // A client message id belongs to whoever first used it. Checked before the conversation is created, so a
  // refused send leaves no row behind.
  const [taken] = await db
    .select({ id: messages.id, conversationId: messages.conversationId, senderUserId: messages.senderUserId })
    .from(messages)
    .where(eq(messages.clientMsgId, clientMsgId));
  if (taken) {
    if (taken.senderUserId !== fanId) throw new SendRefused("not_a_fan");
    return { conversationId: taken.conversationId, messageId: taken.id, duplicate: true };
  }

  await db.insert(conversations).values({ creatorId, fanId }).onConflictDoNothing();
  const [conv] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.creatorId, creatorId), eq(conversations.fanId, fanId)));

  const [inserted] = await db
    .insert(messages)
    .values({ conversationId: conv.id, sender: "fan", senderUserId: fanId, body: text, clientMsgId })
    .onConflictDoNothing({ target: messages.clientMsgId })
    .returning({ id: messages.id });
  if (!inserted) {
    const [existing] = await db
      .select({ id: messages.id, conversationId: messages.conversationId, senderUserId: messages.senderUserId })
      .from(messages)
      .where(eq(messages.clientMsgId, clientMsgId));
    // A client message id belongs to whoever first used it.
    if (!existing || existing.senderUserId !== fanId) throw new SendRefused("not_a_fan");
    return { conversationId: existing.conversationId, messageId: existing.id, duplicate: true };
  }

  // He has stopped typing: the engine must not keep holding his turn for a ping that is still in the future.
  await db.update(conversations).set({ fanTypingUntil: null }).where(eq(conversations.id, conv.id));

  schedule(async () => processConversation(conv.id, await defaultDeps()));
  return { conversationId: conv.id, messageId: inserted.id, duplicate: false };
}
