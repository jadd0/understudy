import { sql } from "drizzle-orm";
import { withTx } from "@/db/client";
import type { Events } from "@understudy/engine";
import { defaultEvents } from "@/providers/pusher/events";
import { loadSeats, type Seats } from "./humans";
import { applyRunUndo, stopRuns } from "./run";

export interface ResetResult {
  stopped: number;
  fans: number;
}

/**
 * The one wholesale delete in the codebase, scoped to `is_sim` fans. It stops every live run first (a run mid-beat
 * errors on the rows it lost and ends), then deletes in foreign-key order inside one transaction: the circular
 * references between messages, turns, offers and handoffs are cut before the rows go, and the ledger's append-only trigger is off only inside this transaction. A human fan's rows are never selected.
 */
export async function resetSim(opts: { seats?: Seats; events?: Events } = {}): Promise<ResetResult> {
  // Stopping applies each run's undo (as the creator seat) before any row is deleted, so the list is not lost with the run.
  const stopped = await stopRuns(undefined, "reset", opts);
  // A run already stopped earlier may still hold an undo that failed; try those too.
  const left = await withTx((tx) => tx.execute(sql`select id from sim_runs where jsonb_array_length(coalesce(variant->'undo', '[]'::jsonb)) > 0`));
  const seats = opts.seats ?? (await loadSeats());
  for (const r of left.rows as { id: string }[]) await applyRunUndo(r.id, seats, opts.events ?? defaultEvents());
  const fans = await withTx(async (tx) => {
    const sims = sql`(select id from users where is_sim = true and role = 'fan')`;
    const convs = sql`(select id from conversations where fan_id in ${sims})`;
    await tx.execute(sql`update messages set turn_id = null, offer_id = null where conversation_id in ${convs}`);
    await tx.execute(sql`update turns set offer_id = null, handoff_id = null where conversation_id in ${convs}`);
    await tx.execute(sql`update offers set turn_id = null where conversation_id in ${convs}`);
    await tx.execute(sql`delete from sim_runs where fan_id in ${sims}`);
    await tx.execute(sql`delete from messages where conversation_id in ${convs}`);
    await tx.execute(sql`delete from strikes where fan_id in ${sims}`);
    await tx.execute(sql`delete from turns where conversation_id in ${convs}`);
    await tx.execute(sql`delete from handoffs where conversation_id in ${convs}`);
    await tx.execute(sql`delete from unlocks where fan_id in ${sims}`);
    // The ledger refuses UPDATE and DELETE by trigger. Reset is the one deliberate exception: the trigger is switched off
    // for this transaction only (DDL is transactional, so a failure leaves it on) and the delete is scoped to sim fans.
    await tx.execute(sql`alter table ledger_entries disable trigger ledger_entries_append_only`);
    await tx.execute(sql`delete from ledger_entries where fan_id in ${sims}`);
    await tx.execute(sql`alter table ledger_entries enable trigger ledger_entries_append_only`);
    await tx.execute(sql`delete from offers where conversation_id in ${convs}`);
    await tx.execute(sql`delete from fan_memory where fan_id in ${sims}`);
    await tx.execute(sql`delete from wallets where fan_id in ${sims}`);
    await tx.execute(sql`delete from conversations where fan_id in ${sims}`);
    await tx.execute(sql`delete from verification_tokens where identifier in (select email from users where is_sim = true and role = 'fan')`);
    await tx.execute(sql`delete from sessions where user_id in ${sims}`);
    await tx.execute(sql`delete from accounts where user_id in ${sims}`);
    const gone = await tx.execute(sql`delete from users where is_sim = true and role = 'fan' returning id`);
    return gone.rows.length;
  });
  return { stopped, fans };
}
