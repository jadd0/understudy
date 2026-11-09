import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { conversations } from "@/db/schema";
import { TYPING_WINDOW_SECONDS } from "./typing-window";

/**
 * Records that the fan is typing in his own conversation with the creator. `fanId` comes from the session in the
 * calling action and the conversation is found from it, never from client input. Returns false when the fan has no
 * conversation yet (nothing is waiting for him then), or when a ping less than a second old already covers him: the
 * write is skipped, so a scripted client cannot turn pings into a stream of row updates (the composer sends one per 2s).
 */
export async function markFanTyping(fanId: string, creatorId: string): Promise<boolean> {
  const rows = await db
    .update(conversations)
    .set({ fanTypingUntil: sql`now() + make_interval(secs => ${TYPING_WINDOW_SECONDS})` as unknown as Date })
    .where(
      and(
        eq(conversations.fanId, fanId),
        eq(conversations.creatorId, creatorId),
        sql`(${conversations.fanTypingUntil} is null or ${conversations.fanTypingUntil} < now() + make_interval(secs => ${TYPING_WINDOW_SECONDS - 1}))`,
      ),
    )
    .returning({ id: conversations.id });
  return rows.length > 0;
}
