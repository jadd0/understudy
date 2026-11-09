import { and, eq, ne, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { handoffs } from "@/db/schema";
import type { HandoffQueue, HandoffReason } from "./types";

/**
 * Opens a handoff for a conversation, or escalates the one already open: there is at most one unresolved
 * handoff per conversation. Trust & Safety outranks the creator, so a ts request moves the row to the ts queue
 * (and reopens it if the creator had claimed it) under the new reason. Within one queue the earlier reason
 * stands, except that a creator `high_value_alert` is only an alert and gives way to any real reason.
 * A `high_value_alert` never changes an existing row. Returns the row id.
 */
export async function openHandoff(
  tx: Tx,
  conversationId: string,
  queue: HandoffQueue,
  reason: HandoffReason,
): Promise<string> {
  const unresolved = ne(handoffs.status, "resolved");
  const index = sql`${handoffs.status} <> 'resolved'`; // the partial unique index's predicate

  if (reason === "high_value_alert") {
    await tx.insert(handoffs).values({ conversationId, queue, reason }).onConflictDoNothing({ target: handoffs.conversationId, where: index });
  } else {
    await tx
      .insert(handoffs)
      .values({ conversationId, queue, reason })
      .onConflictDoUpdate({
        target: handoffs.conversationId,
        targetWhere: index,
        set: {
          queue: sql`case when excluded.queue = 'ts' then 'ts'::handoff_queue else ${handoffs.queue} end`,
          reason: sql`case
            when excluded.queue = 'ts' and ${handoffs.queue} <> 'ts' then excluded.reason
            when ${handoffs.queue} = excluded.queue and ${handoffs.reason} = 'high_value_alert' then excluded.reason
            else ${handoffs.reason} end`,
          status: sql`case when excluded.queue = 'ts' and ${handoffs.queue} <> 'ts' then 'open'::handoff_status else ${handoffs.status} end`,
          claimedBy: sql`case when excluded.queue = 'ts' and ${handoffs.queue} <> 'ts' then null else ${handoffs.claimedBy} end`,
          claimedAt: sql`case when excluded.queue = 'ts' and ${handoffs.queue} <> 'ts' then null else ${handoffs.claimedAt} end`,
        },
      });
  }
  const [row] = await tx
    .select({ id: handoffs.id })
    .from(handoffs)
    .where(and(eq(handoffs.conversationId, conversationId), unresolved));
  return row.id;
}
