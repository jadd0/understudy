import { after } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { creators, users } from "@/db/schema";
import { chatter } from "@/lib/host/deps";
import { MAX_CLIENT_MSG_ID_CHARS, MAX_MESSAGE_CHARS, MessageRefused, type Chatter } from "@understudy/engine";

/** A host page or route that calls `sendFanMessage` re-exports this as its `maxDuration` (seconds). */
export const ENGINE_MAX_DURATION_S = 60;

export { MAX_CLIENT_MSG_ID_CHARS, MAX_MESSAGE_CHARS };

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
  /** The engine to store through. Callers that run the engine themselves pass their own wiring instead of the production one. */
  engine: () => Promise<Chatter> = chatter,
): Promise<SendResult> {
  // Cheap input checks first, so a malformed send is refused for that before any lookup.
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

  try {
    const handled = await (await engine()).handleMessage({ creatorId, fanId, body, clientMsgId });
    if (!handled.duplicate) schedule(handled.process);
    return { conversationId: handled.conversationId, messageId: handled.messageId, duplicate: handled.duplicate };
  } catch (e) {
    // A client message id belongs to whoever first used it: another fan's is not a send from a fan of this chat.
    if (e instanceof MessageRefused) throw new SendRefused(e.code === "not_owner" ? "not_a_fan" : e.code);
    throw e;
  }
}
