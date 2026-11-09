import { eq } from "drizzle-orm";
import type { EngineCtx } from "../ctx";
import { conversations } from "../db/schema";
import { getConfig, loadEngineConfig, loadSla, type EngineCfg } from "../config/load";
import { acquireLease, recordFailure, releaseLease, type Lease } from "../conversation/lease";
import { finishTurn } from "./finish";
import { newWorkSince } from "./inbound";
import { tipRowIds, type Candidate, type PassResult } from "./pass";
import { runPass } from "./pass-run";
import { basePlan, unsafePlan, type TurnRecord } from "./plan";
import { describeError, type TurnResult } from "./result";
import { openTurnState } from "./state";

/**
 * One turn: lease, wait out the debounce, classify, route, (pick an offer, draft, verify), commit. Provider calls
 * run outside any transaction. Any failure after the lease records an error turn and answers nothing.
 */
export async function runTurn(ctx: EngineCtx, conversationId: string): Promise<TurnResult> {
  const [conv] = await ctx.db.select().from(conversations).where(eq(conversations.id, conversationId));
  if (!conv) return { status: "idle" };
  const leaseMs = await getConfig<number>(ctx, "engine.lease_ms", conv.creatorId);
  // Read before the lease, like the lease length: a failure later in the turn (a missing engine row included)
  // still knows when to hand over, and a missing row here fails the turn before anything is held.
  const maxAttempts = await getConfig<number>(ctx, "engine.max_attempts", conv.creatorId);
  const sla = await loadSla(ctx, conv.creatorId);
  const lease = await acquireLease(ctx, conversationId, leaseMs);
  if (!lease) return { status: "busy" };

  const acc: TurnRecord = {
    inboundIds: [],
    route: null,
    jevIn: null,
    jevOut: null,
    draft: null,
    personaVersion: null,
    models: null,
    tokens: null,
    costMicros: 0,
    msJevIn: null,
    msGen: null,
    msJevOut: null,
    attempts: null,
  };
  try {
    const cfg = await loadEngineConfig(ctx, lease.creatorId);
    return await attemptTurn(ctx, lease, cfg, acc);
  } catch (e) {
    console.error(`engine: turn failed ${describeError(e)}`);
    try {
      const failure = await recordFailure(ctx, lease, acc, maxAttempts, sla);
      return { status: "error", turnId: failure.turnId };
    } catch (inner) {
      console.error(`engine: could not record failure ${describeError(inner)}`);
      await releaseLease(ctx, lease).catch(() => {});
      throw e;
    }
  }
}

async function attemptTurn(ctx: EngineCtx, lease: Lease, cfg: EngineCfg, acc: TurnRecord): Promise<TurnResult> {
  const s = await openTurnState(ctx, lease, cfg, acc);

  let safe: Candidate | null = null;
  for (;;) {
    let pass: PassResult;
    try {
      pass = await runPass(s);
    } catch (e) {
      // A fold-in pass that errors leaves the earlier safe draft standing for its own batch, as one that finds
      // nothing safe does; the late messages wait for the next turn.
      if (!safe) throw e;
      console.error(`engine: fold-in pass failed, keeping the earlier safe draft ${describeError(e)}`);
      s.trail.push({ passError: describeError(e) });
      break;
    }
    if (pass.kind === "idle") {
      if (!safe) {
        await releaseLease(ctx, lease);
        return { status: "idle" };
      }
      break;
    }
    if (pass.kind === "final") return finishTurn(s, pass.plan, pass.route, pass.batchText);
    if (pass.candidate) {
      safe = pass.candidate;
      const late = s.foldIns < cfg.foldInMax && s.budgetOk() ? await newWorkSince(ctx, lease.conversationId, safe.seenKeys, cfg.eventWindowMinutes) : false;
      if (late) {
        // He wrote, tipped or unlocked while she was drafting: throw this draft away and answer the whole batch.
        s.foldIns++;
        s.trail.push({ folded: true });
        continue;
      }
      break;
    }
    if (safe) break; // A later pass found nothing safe: the earlier draft, for the earlier batch, still stands.
    return finishTurn(s, unsafePlan(s, pass.failed, pass.lastDraft), pass.failed.route, pass.failed.batchText);
  }

  // Commit the newest draft that passed safety, restoring the context it was written for.
  const c = safe!;
  acc.inboundIds = c.inboundIds;
  acc.draft = c.draft;
  acc.attempts = c.attempts;
  const plan = basePlan(s, c.route, c.declineOfferId, c.jevIn);
  plan.reply = { body: c.draft, kind: "sent" };
  plan.eventMessageIds = tipRowIds(c.events);
  if (c.offerItem && c.route.name === "offer") {
    plan.offer = { itemId: c.offerItem.id, priceCents: c.offerItem.priceCents, ttlMinutes: cfg.offerTtlMinutes };
  }
  return finishTurn(s, plan, c.route, c.batchText);
}
