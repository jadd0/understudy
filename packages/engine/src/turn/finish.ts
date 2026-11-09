import { eq, sql } from "drizzle-orm";
import { turns } from "../db/schema";
import { extractMemory } from "../drafting/memory";
import type { Route } from "../types";
import { commitTurn } from "./commit";
import { costMicros } from "./cost";
import { emitDelivery } from "./deliver";
import type { CommitPlan } from "./plan";
import { describeError, type TurnResult } from "./result";
import type { TurnState } from "./state";

/** Commits the plan, tells the console and the fan's screen what changed, and learns from what the fan wrote. */
export async function finishTurn(s: TurnState, p: CommitPlan, r: Route, text: string): Promise<TurnResult> {
  const { ctx, lease, cfg } = s;
  const { events } = ctx.deps;
  const result = await commitTurn(ctx, lease, p);
  if (result.applied) {
    // The console inbox (preview, time, badge) refreshes on this; a reply, a hold or a hard stop all change it.
    await events
      .emit(`creator:${lease.creatorId}`, "inbox.changed", { conversationId: lease.conversationId })
      .catch((e) => console.error(`engine: emit failed ${describeError(e)}`));
  }
  // A hard stop's template is delivered even when the commit lost the race.
  if (p.reply?.kind === "sent" || p.strike) await emitDelivery(events, lease.conversationId, result);
  if (!result.applied) return { status: "superseded", turnId: result.turnId };

  // A reaction to a tip or an unlock has no fan text to learn from.
  if ((p.outcome === "replied" || p.outcome === "suggested") && text.trim() !== "") {
    try {
      const usage = await extractMemory(ctx, {
        creatorId: lease.creatorId,
        fanId: lease.fanId,
        fanText: text,
        model: cfg.memoryModel,
        maxTokens: cfg.maxTokens,
      });
      if (usage) {
        const micros = costMicros(cfg.prices[cfg.memoryModel], usage);
        await ctx.db
          .update(turns)
          .set({
            costMicros: sql`${turns.costMicros} + ${micros}`,
            tokens: sql`coalesce(${turns.tokens}, '{}'::jsonb) || ${JSON.stringify({ memory: usage })}::jsonb`,
          })
          .where(eq(turns.id, result.turnId));
      }
    } catch (e) {
      console.error(`engine: memory failed ${describeError(e)}`);
    }
  }
  return { status: "committed", turnId: result.turnId, route: r.name, outcome: p.outcome, creatorId: lease.creatorId };
}
