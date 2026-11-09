import { and, eq, ne, sql } from "drizzle-orm";
import type { EngineTx } from "../ports/db";
import { handoffs } from "../db/schema";
import type { HandoffQueue, HandoffReason } from "../types";

/** Minutes from opening to the due time, per queue (config `escalation.*_sla_minutes`). */
export interface HandoffSla {
  creatorMinutes: number;
  tsMinutes: number;
}

/**
 * Opens a handoff for a conversation, or escalates the one already open: there is at most one unresolved
 * handoff per conversation. Trust & Safety outranks the creator, so a ts request moves the row to the ts queue
 * (and reopens it if the creator had claimed it) under the new reason. Within one queue the earlier reason
 * stands, except that a creator `high_value_alert` is only an alert and gives way to any real reason.
 * A `high_value_alert` never changes an existing row. Returns the row id.
 *
 * A new row is due `sla` minutes after it opens (creator or ts, by its queue). A row that moves to the ts queue, or
 * a creator alert that gives way to a real reason, starts its clock again under the new queue's or reason's SLA.
 */
export async function openHandoff(
  tx: EngineTx,
  conversationId: string,
  queue: HandoffQueue,
  reason: HandoffReason,
  sla?: HandoffSla,
): Promise<string> {
  const unresolved = ne(handoffs.status, "resolved");
  const index = sql`${handoffs.status} <> 'resolved'`; // the partial unique index's predicate
  const minutes = sla ? (queue === "ts" ? sla.tsMinutes : sla.creatorMinutes) : null;
  const dueAt = minutes === null ? null : (sql`now() + ${minutes}::numeric * interval '1 minute'` as unknown as Date);

  if (reason === "high_value_alert") {
    await tx.insert(handoffs).values({ conversationId, queue, reason, dueAt }).onConflictDoNothing({ target: handoffs.conversationId, where: index });
  } else {
    await tx
      .insert(handoffs)
      .values({ conversationId, queue, reason, dueAt })
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
          dueAt: sql`case
            when excluded.queue = 'ts' and ${handoffs.queue} <> 'ts' then excluded.due_at
            when ${handoffs.queue} = excluded.queue and ${handoffs.reason} = 'high_value_alert' then excluded.due_at
            else ${handoffs.dueAt} end`,
          slaBreachedAt: sql`case when excluded.queue = 'ts' and ${handoffs.queue} <> 'ts' then null else ${handoffs.slaBreachedAt} end`,
        },
      });
  }
  const [row] = await tx
    .select({ id: handoffs.id })
    .from(handoffs)
    .where(and(eq(handoffs.conversationId, conversationId), unresolved));
  return row.id;
}
