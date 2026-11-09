import { sql } from "drizzle-orm";
import type { EngineTx } from "../ports/db";

export interface StrikeScope {
  creatorId: string;
  fanId: string;
  /** Strikes older than this many days (database clock) do not count. */
  windowDays: number;
}

/** Strikes this fan has with this creator inside the window. Strikes are per creator: a strike with another creator is not counted. */
export async function countStrikes(tx: Pick<EngineTx, "execute">, scope: StrikeScope): Promise<number> {
  const { rows } = await tx.execute(sql`
    select count(*)::int as n from strikes
    where creator_id = ${scope.creatorId} and fan_id = ${scope.fanId}
      and created_at > now() - make_interval(days => ${scope.windowDays}::int)`);
  return (rows[0] as { n: number }).n;
}

/**
 * Records one strike and returns its number (1 for the first inside the window). The conversation row is locked
 * first, as the lock order requires, so two commits for one fan with one creator count one after the other: the
 * second reads the first's row and is strike 2, never a second strike 1.
 */
export async function recordStrike(
  tx: Pick<EngineTx, "execute">,
  scope: StrikeScope & { conversationId: string; turnId: string | null; reason: string },
): Promise<number> {
  await tx.execute(sql`select 1 from conversations where id = ${scope.conversationId} for update`);
  const before = await countStrikes(tx, scope);
  await tx.execute(sql`
    insert into strikes (creator_id, fan_id, conversation_id, turn_id, reason)
    values (${scope.creatorId}, ${scope.fanId}, ${scope.conversationId}, ${scope.turnId}, ${scope.reason})`);
  return before + 1;
}
