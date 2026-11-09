import { sql } from "drizzle-orm";
import { getConfig } from "../config/load";
import type { EngineCtx } from "../ctx";
import { runEscalations } from "./escalation";
import { expireOffers } from "./offer";
import { processConversation } from "../turn/process";
import { describeError } from "../turn/result";

export interface SweepResult {
  leasesCleared: number;
  conversationsProcessed: number;
  offersExpired: number;
  handoffsAutoResolved: number;
  tsBreaches: number;
}

/** A sweep run is bounded so it fits one function invocation; the next minute takes the rest. */
const MAX_CONVERSATIONS_PER_SWEEP = 10;

/**
 * The sweep runs inside a 60 s function (ENGINE_MAX_DURATION_S). It stops starting new conversations once this
 * much of that has gone, so the one in flight can finish; the next minute takes the rest.
 */
export const SWEEP_START_BUDGET_MS = 35_000;

/**
 * The safety net behind the per-send trigger: (1) expired leases are cleared, (2) AI conversations holding fan
 * messages no turn has answered, older than the debounce and with no live lease, are processed oldest message
 * first, (3) expired open offers are marked, (4) handoffs past their due time are settled by policy or stamped late. All comparisons use the database clock; the start budget uses the injected clock.
 */
export async function sweep(ctx: EngineCtx): Promise<SweepResult> {
  const started = ctx.deps.clock.now();
  const debounceMs = await getConfig<number>(ctx, "engine.debounce_ms");

  const cleared = await ctx.db.execute(sql`
    update conversations set lease_token = null, lease_until = null
    where lease_until is not null and lease_until < now() returning id`);

  const { rows } = await ctx.db.execute(sql`
    select c.id, min(m.created_at) as oldest from conversations c
    join messages m on m.conversation_id = c.id
    where c.mode = 'ai' and c.ai_enabled and c.lease_until is null
      and m.sender = 'fan' and m.turn_id is null
      and m.created_at < now() - make_interval(secs => ${debounceMs / 1000})
      and m.created_at > coalesce((select max(o.created_at) from messages o
                                   where o.conversation_id = c.id and o.sender in ('creator', 'admin') and o.status = 'sent'),
                                  'epoch'::timestamptz)
    group by c.id
    order by min(m.created_at), c.id
    limit ${MAX_CONVERSATIONS_PER_SWEEP}`);
  let processed = 0;
  for (const row of rows as { id: string }[]) {
    if (ctx.deps.clock.now() - started >= SWEEP_START_BUDGET_MS) break;
    try {
      await processConversation(ctx, row.id);
      processed++;
    } catch (e) {
      console.error(`engine: sweep ${describeError(e)}`);
    }
  }
  const offersExpired = await expireOffers(ctx);
  const escalations = await runEscalations(ctx);
  return {
    leasesCleared: cleared.rows.length,
    conversationsProcessed: processed,
    offersExpired,
    handoffsAutoResolved: escalations.autoResolved,
    tsBreaches: escalations.tsBreaches,
  };
}
