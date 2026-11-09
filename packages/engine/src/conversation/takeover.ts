import { and, eq, ne, sql } from "drizzle-orm";
import type { EngineCtx } from "../ctx";
import { supersedeUnseenBubbles } from "../turn/commit";
import { conversations, handoffs, messages } from "../db/schema";

/** Who is acting on a conversation. A creator holds only her own, non-T&S chats; the T&S side holds any. */
export type HumanActor = { id: string; side: "creator"; creatorId: string } | { id: string; side: "ts" };

export const TAKEOVER_REFUSED_CODES = ["not_found", "not_allowed"] as const;
export type TakeoverRefusedCode = (typeof TAKEOVER_REFUSED_CODES)[number];

export class TakeoverRefused extends Error {
  constructor(public readonly code: TakeoverRefusedCode) {
    super(`takeover refused: ${code}`);
    this.name = "TakeoverRefused";
  }
}

export const MAX_HUMAN_BODY_CHARS = 2000;

const isTsSide = (mode: string) => mode === "handoff_ts" || mode === "human_ts";

/**
 * A human takes over a conversation. `actor` must come from the host's session, never from client input. A creator
 * actor may take over only a conversation of her own creator that is not on the T&S side; a T&S actor may take over
 * any conversation in any mode, and it then sits on the T&S side. In one transaction: the conversation row is locked
 * and moved to the human mode with its version bumped (so a turn mid-flight fails its compare-and-set), the lease is
 * dropped, the open handoff is claimed by the actor, and AI messages the fan has not seen yet (`deliver_at` still
 * ahead) are superseded; an open offer on one of them is expired. Messages the fan already saw stay.
 */
export async function takeOver(ctx: Pick<EngineCtx, "db">, conversationId: string, actor: HumanActor): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [conv] = await tx.select().from(conversations).where(eq(conversations.id, conversationId)).for("update");
    if (!conv) throw new TakeoverRefused("not_found");
    const byTs = actor.side === "ts";
    if (!byTs && (isTsSide(conv.mode) || conv.creatorId !== actor.creatorId)) throw new TakeoverRefused("not_allowed");

    await tx
      .update(conversations)
      .set({
        mode: byTs ? "human_ts" : "human_creator",
        version: sql`${conversations.version} + 1` as unknown as number,
        leaseToken: null,
        leaseUntil: null,
      })
      .where(eq(conversations.id, conversationId));
    // A T&S actor also takes a chat another one already holds: the claim moves to whoever took over last.
    await tx
      .update(handoffs)
      .set({ status: "claimed", claimedBy: actor.id, claimedAt: sql`now()` })
      .where(and(eq(handoffs.conversationId, conversationId), byTs ? ne(handoffs.status, "resolved") : eq(handoffs.status, "open")));
    await supersedeUnseenBubbles(tx, conversationId);
  });
}

/**
 * Stores a human's message in a conversation the actor holds: mode `human_creator` for a creator actor of that
 * creator, `human_ts` for a T&S actor. Anything else is `TakeoverRefused("not_allowed")`. The mode is checked under
 * the conversation lock, so a hand-back cannot slip between the check and the write. `clientMsgId` makes a retried
 * send returns the saved row; an id already used by another sender is `TakeoverRefused("not_allowed")`. Emits `message.created` on the conversation's channel; returns the message id.
 */
export async function humanReply(
  ctx: EngineCtx,
  conversationId: string,
  actor: HumanActor,
  body: string,
  opts: { clientMsgId?: string | null } = {},
): Promise<string> {
  const text = body.trim();
  if (!text || text.length > MAX_HUMAN_BODY_CHARS) throw new RangeError("human reply body must be 1..2000 characters");
  const clientMsgId = opts.clientMsgId ?? null;
  const id = await ctx.db.transaction(async (tx) => {
    const [locked] = await tx.select().from(conversations).where(eq(conversations.id, conversationId)).for("update");
    if (!locked) throw new TakeoverRefused("not_found");
    const holds = actor.side === "ts" ? locked.mode === "human_ts" : locked.mode === "human_creator" && locked.creatorId === actor.creatorId;
    if (!holds) throw new TakeoverRefused("not_allowed");
    const [m] = await tx
      .insert(messages)
      .values({ conversationId, sender: actor.side === "ts" ? "admin" : "creator", senderUserId: actor.id, body: text, clientMsgId })
      .onConflictDoNothing({ target: messages.clientMsgId })
      .returning({ id: messages.id });
    if (m) return m.id;
    // A retried send with the same client id: the message is already saved, so it is not written twice.
    const [held] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.clientMsgId, clientMsgId!), eq(messages.senderUserId, actor.id)));
    if (!held) throw new TakeoverRefused("not_allowed");
    return held.id;
  });
  await ctx.deps.events.emit(`conversation:${conversationId}`, "message.created", { messageId: id, deliverInMs: 0 }).catch(() => {});
  return id;
}
