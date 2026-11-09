import { and, eq, ne, sql } from "drizzle-orm";
import { withTx } from "@/db/client";
import { conversations, creators, handoffs, users } from "@/db/schema";
import { supersedeUnseenBubbles } from "@/lib/engine/lease";

export { handBack } from "@/lib/engine/lease";

export class TakeoverRefused extends Error {
  constructor(public readonly code: "not_found" | "not_allowed") {
    super(`takeover refused: ${code}`);
    this.name = "TakeoverRefused";
  }
}

/**
 * A human takes over a conversation. `actorUserId` must come from the caller's session, never from client input.
 * The creator may take over their own non-T&S conversations; a Trust & Safety conversation needs an admin, and an
 * admin may take over nothing else. In one
 * transaction: the conversation row is locked and moved to the human mode with its version bumped (so a turn
 * mid-flight fails its compare-and-set), the lease is dropped, the open handoff is claimed by the actor, and AI
 * messages the fan has not seen yet (`deliver_at` still ahead) are superseded; an open offer on one of them is expired. Messages the fan already saw stay.
 */
export async function takeover(conversationId: string, actorUserId: string): Promise<void> {
  await withTx(async (tx) => {
    const [conv] = await tx.select().from(conversations).where(eq(conversations.id, conversationId)).for("update");
    if (!conv) throw new TakeoverRefused("not_found");
    const [actor] = await tx.select({ role: users.role }).from(users).where(eq(users.id, actorUserId));
    const tsSide = conv.mode === "handoff_ts" || conv.mode === "human_ts";
    // An admin may take over any conversation, in any mode; it then sits on the T&S side, out of the
    // creator's sight. A creator may take over only her own, and never one on the T&S side.
    const byAdmin = actor?.role === "admin";
    let allowed = byAdmin;
    if (!tsSide && actor?.role === "creator") {
      const [owner] = await tx
        .select({ id: creators.id })
        .from(creators)
        .where(and(eq(creators.id, conv.creatorId), eq(creators.userId, actorUserId)));
      allowed = Boolean(owner);
    }
    if (!allowed) throw new TakeoverRefused("not_allowed");

    await tx
      .update(conversations)
      .set({
        mode: byAdmin ? "human_ts" : "human_creator",
        version: sql`${conversations.version} + 1` as unknown as number,
        leaseToken: null,
        leaseUntil: null,
      })
      .where(eq(conversations.id, conversationId));
    // An admin also takes a chat another admin already holds: the claim moves to whoever took over last.
    await tx
      .update(handoffs)
      .set({ status: "claimed", claimedBy: actorUserId, claimedAt: sql`now()` })
      .where(and(eq(handoffs.conversationId, conversationId), byAdmin ? ne(handoffs.status, "resolved") : eq(handoffs.status, "open")));
    await supersedeUnseenBubbles(tx, conversationId);
  });
}
