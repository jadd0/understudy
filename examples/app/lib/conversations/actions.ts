import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { creators, users } from "@/db/schema";
import { handBack as engineHandBack, takeOver, TakeoverRefused, type HumanActor } from "@understudy/engine";

export { TakeoverRefused };

/** Gives a conversation back to the AI. Needs only the database: no providers, no settings. */
export const handBack = (conversationId: string, opts?: { allWaiting?: boolean }) => engineHandBack({ db }, conversationId, opts);

/** A creator no one owns: holds no conversation, so an actor who is neither admin nor creator is refused after the lookup. */
const NO_CREATOR = "00000000-0000-0000-0000-000000000000";

/** Maps the app's user to the engine's side: an admin is the T&S side, a creator holds her own creator row. */
export async function humanActorOf(userId: string): Promise<HumanActor> {
  const [actor] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  if (actor?.role === "admin") return { id: userId, side: "ts" };
  const [owned] = actor?.role === "creator" ? await db.select({ id: creators.id }).from(creators).where(eq(creators.userId, userId)) : [];
  return { id: userId, side: "creator", creatorId: owned?.id ?? NO_CREATOR };
}

/**
 * A human takes over a conversation. `actorUserId` must come from the caller's session, never from client input.
 * The creator may take over their own non-T&S conversations; a Trust & Safety conversation needs an admin, and an
 * admin may take over nothing else. The transaction is the engine's.
 */
export async function takeover(conversationId: string, actorUserId: string): Promise<void> {
  await takeOver({ db }, conversationId, await humanActorOf(actorUserId));
}
