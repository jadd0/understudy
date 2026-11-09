import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, withTx } from "@/db/client";
import { simRuns } from "@/db/schema";
import { getConfig } from "@/lib/config";
import { batchCostMicros, runCostMicros } from "./cost";
import type { SimDeps } from "./deps";
import { loadSeats, undoAll, type HumanCtx, type Seats, type UndoRecord } from "./humans";
import { humanBeat, messageBeat, moneyBeat, type BeatEnv, type BeatOutcome } from "./beats";
import { personaBySlug, type Persona } from "./persona";
import { conversationOf } from "./agent";
import type { Variant } from "./random";
import { liveRunCount } from "./spawn";
import { defaultEvents } from "@/providers/pusher/events";
import { summariseRun, type BeatResult } from "./score";

export type AdvanceReason = "finished" | "budget" | "no_lease" | "concurrency" | "stopped" | "waiting" | "retry_later" | "lost_lease";

export interface AdvanceResult {
  advanced: number;
  reason: AdvanceReason;
  stopReason?: string;
}

type RunRow = typeof simRuns.$inferSelect;
const LIVE = ["queued", "running", "waiting_human"] as const;

export interface AdvanceOpts {
  budgetMs: number;
  seats?: Seats;
  personas?: Persona[];
  /** Stop after this many beats (tests and single-stepping); the lease is released and the run stays live. */
  maxBeats?: number;
}

/**
 * Leases the run row (a second caller gets nothing), then executes beats from `next_beat` until the persona is done,
 * the time budget is spent, a human is awaited, the kill switch or a cost cap fires, or the run is stopped. The beat
 * index moves forward only in the same update that writes the beat's log entry, guarded by the lease and the index,
 * so a beat is never skipped or logged twice.
 */
export async function advanceRun(runId: string, deps: SimDeps, opts: AdvanceOpts): Promise<AdvanceResult> {
  const started = Date.now();
  const leaseMs = await getConfig<number>("sim.lease_ms");
  const token = randomUUID();
  const live = await liveRunCount();
  const maxConcurrent = await getConfig<number>("sim.max_concurrent_runs");

  const [leased] = await db
    .update(simRuns)
    .set({ leaseToken: token, leaseUntil: sql`now() + make_interval(secs => ${leaseMs / 1000})` })
    .where(and(eq(simRuns.id, runId), inArray(simRuns.status, [...LIVE]), sql`(${simRuns.leaseUntil} is null or ${simRuns.leaseUntil} < now())`))
    .returning();
  if (!leased) return { advanced: 0, reason: "no_lease" };
  if (leased.status === "queued" && live >= maxConcurrent) {
    await releaseLease(runId, token);
    return { advanced: 0, reason: "concurrency" };
  }
  if (leased.status === "queued") {
    await db.update(simRuns).set({ status: "running", startedAt: sql`now()` }).where(and(eq(simRuns.id, runId), eq(simRuns.leaseToken, token)));
  }

  const persona = personaBySlug(leased.personaSlug, opts.personas);
  const variant = leased.variant as Variant & { undo?: UndoRecord[] };
  const seats = opts.seats ?? (await loadSeats());
  const humans: HumanCtx = {
    conversationId: leased.conversationId ?? "",
    fanId: leased.fanId,
    creatorId: leased.creatorId,
    seats,
    events: deps.engine.events,
    undo: variant.undo ?? [],
    persist: (undo) => persistUndo(runId, undo),
  };
  const env: BeatEnv = {
    runId,
    mode: leased.mode,
    persona,
    variant,
    seed: leased.seed ?? "0",
    deps,
    fanId: leased.fanId,
    creatorId: leased.creatorId,
    humans,
    micros: 0,
  };

  let advanced = 0;
  for (;;) {
    const [row] = await db.select().from(simRuns).where(eq(simRuns.id, runId));
    if (!row) {
      // The row is gone (a reset): whatever this run changed in shared state is still put back.
      if (env.humans.undo.length) await undoAll(env.humans);
      return { advanced, reason: "lost_lease" };
    }
    if (row.leaseToken !== token) return { advanced, reason: "lost_lease" };
    if (row.status === "stopped") {
      await finishUndo(env, runId, token);
      return { advanced, reason: "stopped", stopReason: row.stopReason ?? undefined };
    }

    const stop = await stopReason(row, deps);
    if (stop) {
      await finish(env, row, token, "stopped", stop);
      return { advanced, reason: "stopped", stopReason: stop };
    }
    if (row.nextBeat >= persona.beats.length) {
      await finish(env, row, token, "done", null);
      return { advanced, reason: "finished" };
    }
    if (Date.now() - started >= opts.budgetMs || (opts.maxBeats !== undefined && advanced >= opts.maxBeats)) {
      await releaseLease(runId, token);
      return { advanced, reason: "budget" };
    }

    const index = row.nextBeat;
    const beat = persona.beats[index];
    env.micros = 0;
    let outcome: BeatOutcome;
    try {
      outcome = await execute(env, index, beat, runId, token);
    } catch (e) {
      const code = (e as { simCode?: string }).simCode ?? (e as { code?: string }).code ?? (e as Error).name;
      env.micros += (e as { micros?: number }).micros ?? 0;
      const rateLimited = /429/.test(String(code));
      const retried = (row.log as { index: number; retry?: boolean }[]).some((l) => l.index === index && l.retry);
      if (rateLimited && !retried) {
        // One retry of this beat after the lease would have lapsed anyway.
        await db.update(simRuns).set({ log: sql`${simRuns.log} || ${JSON.stringify([{ index, retry: true, code: "provider_429", at: new Date().toISOString() }])}::jsonb`, leaseUntil: sql`now() + make_interval(secs => ${leaseMs / 1000})`, costMicros: sql`${simRuns.costMicros} + ${env.micros}` }).where(and(eq(simRuns.id, runId), eq(simRuns.leaseToken, token)));
        return { advanced, reason: "retry_later" };
      }
      outcome = {
        result: { index, kind: beat.kind, label: `${beat.kind}`, status: "failed", at: new Date().toISOString(), score: { violations: [], failures: [{ beat: index, kind: "beat_error", detail: String(code).slice(0, 80) }], pending: [], routeMisses: [] } },
        stop: "beat_error",
      };
    }

    const [moved] = await db
      .update(simRuns)
      .set({
        log: sql`${simRuns.log} || ${JSON.stringify([outcome.result])}::jsonb`,
        nextBeat: index + 1,
        costMicros: sql`${simRuns.costMicros} + ${env.micros}`,
        leaseUntil: sql`now() + make_interval(secs => ${leaseMs / 1000})`,
        ...(env.humans.conversationId ? { conversationId: env.humans.conversationId } : {}),
      })
      .where(and(eq(simRuns.id, runId), eq(simRuns.leaseToken, token), eq(simRuns.nextBeat, index), inArray(simRuns.status, [...LIVE])))
      .returning({ id: simRuns.id });
    if (!moved) {
      // A stop that landed mid-beat: the beat's work is already in the database, the index stays, the run ends.
      const [now] = await db.select().from(simRuns).where(eq(simRuns.id, runId));
      if (!now) {
        if (env.humans.undo.length) await undoAll(env.humans);
      } else if (now.status === "stopped" && now.leaseToken === token) {
        await finishUndo(env, runId, token);
        return { advanced, reason: "stopped", stopReason: now.stopReason ?? undefined };
      }
      return { advanced, reason: "lost_lease" };
    }
    advanced++;

    if (outcome.stop) {
      const [after] = await db.select().from(simRuns).where(eq(simRuns.id, runId));
      await finish(env, after, token, outcome.stop === "agent_left" ? "done" : "failed", outcome.stop);
      return { advanced, reason: "stopped", stopReason: outcome.stop };
    }
  }
}

async function execute(env: BeatEnv, index: number, beat: Persona["beats"][number], runId: string, token: string): Promise<BeatOutcome> {
  // The conversation exists once the first message is sent; the run row learns its id after that beat.
  const withConversation = async () => {
    env.humans.conversationId = (await conversationOf(env.fanId, env.creatorId)) ?? "";
  };
  switch (beat.kind) {
    case "say":
    case "free":
    case "line":
    case "burst": {
      const out = await messageBeat(env, index, beat);
      await withConversation();
      return out;
    }
    case "topup":
    case "tip":
    case "set_cap":
    case "unlock":
    case "nudge":
      return moneyBeat(env, index, beat);
    case "human":
      return humanBeat(env, index, beat, async (waiting) => {
        await db.update(simRuns).set({ status: waiting ? "waiting_human" : "running" }).where(and(eq(simRuns.id, runId), eq(simRuns.leaseToken, token)));
      });
    case "wait":
      await env.deps.sleep(beat.ms);
      return { result: { index, kind: "wait", label: `wait ${beat.ms}`, status: "done", at: new Date().toISOString(), score: { violations: [], failures: [], pending: [], routeMisses: [] } } };
  }
}

/** The reason to stop before the next beat, read fresh from config and the database every time (never cached across beats). */
async function stopReason(row: RunRow, deps: SimDeps): Promise<string | null> {
  void deps;
  if (!(await getConfig<boolean>("sim.enabled"))) return "disabled";
  const cap = await getConfig<number>("sim.max_cost_micros_per_run");
  if ((await runCostMicros(row.id)) >= cap) return "cost_cap";
  if (row.batchId) {
    const batchCap = await getConfig<number>("sim.max_cost_micros_per_batch");
    if ((await batchCostMicros(row.batchId)) >= batchCap) return "batch_cost_cap";
  }
  return null;
}

async function releaseLease(runId: string, token: string) {
  await db.update(simRuns).set({ leaseToken: null, leaseUntil: null }).where(and(eq(simRuns.id, runId), eq(simRuns.leaseToken, token)));
}

async function finishUndo(env: BeatEnv, runId: string, token: string) {
  const errors = await applyRunUndo(runId, env.humans.seats, env.humans.events);
  await db.update(simRuns).set({ variant: sql`jsonb_set(coalesce(${simRuns.variant}, '{}'::jsonb), '{undoErrors}', ${JSON.stringify(errors)}::jsonb)`, leaseToken: null, leaseUntil: null }).where(and(eq(simRuns.id, runId), eq(simRuns.leaseToken, token)));
}

async function finish(env: BeatEnv, row: RunRow, token: string, status: "done" | "stopped" | "failed", reason: string | null) {
  const undoErrors = await applyRunUndo(row.id, env.humans.seats, env.humans.events);
  await db
    .update(simRuns)
    .set({ status, stopReason: reason ?? (undoErrors.length ? `undo_failed:${undoErrors.join(",")}` : null), finishedAt: sql`now()`, leaseToken: null, leaseUntil: null })
    .where(and(eq(simRuns.id, row.id), eq(simRuns.leaseToken, token)));
}

/** Writes the run's undo list into `variant.undo` without touching the rest of the variant. */
async function persistUndo(runId: string, undo: UndoRecord[]): Promise<void> {
  await db.update(simRuns).set({ variant: sql`jsonb_set(coalesce(${simRuns.variant}, '{}'::jsonb), '{undo}', ${JSON.stringify(undo)}::jsonb)` }).where(eq(simRuns.id, runId));
}

/**
 * Applies a run's persisted undo list (the switches and the never-list it changed) as the creator seat, under the run
 * row's lock, and clears what was restored. Works with no lease: a stop or a reset calls it for runs whose process is
 * long gone. A record that fails to restore stays in the list for the next attempt; the errors are returned.
 */
export async function applyRunUndo(runId: string, seats: Seats, events: HumanCtx["events"]): Promise<string[]> {
  return withTx(async (tx) => {
    const [row] = await tx.select().from(simRuns).where(eq(simRuns.id, runId)).for("update");
    const undo = ((row?.variant as { undo?: UndoRecord[] } | null)?.undo ?? []).map((u) => ({ ...u }));
    if (!row || undo.length === 0) return [];
    const ctx: HumanCtx = { conversationId: row.conversationId ?? "", fanId: row.fanId, creatorId: row.creatorId, seats, events, undo };
    const errors = await undoAll(ctx);
    await tx.update(simRuns).set({ variant: sql`jsonb_set(coalesce(${simRuns.variant}, '{}'::jsonb), '{undo}', ${JSON.stringify(ctx.undo)}::jsonb)` }).where(eq(simRuns.id, runId));
    return errors;
  });
}

/** The beat results a run has logged so far (the retry markers are not beats). */
export function beatResults(log: unknown): BeatResult[] {
  return (Array.isArray(log) ? log : []).filter((l): l is BeatResult => typeof l === "object" && l !== null && "status" in l);
}

export async function summaryOf(runId: string) {
  const [row] = await db.select().from(simRuns).where(eq(simRuns.id, runId));
  return { row, summary: summariseRun(beatResults(row.log)) };
}

/**
 * Marks runs stopped; each honours it at its next beat. One run, or every live run. Whatever a stopped run changed in
 * shared state (a global AI switch, the never-list) is put back here, as the creator seat, because the run's own
 * process may be gone and nothing else would do it.
 */
export async function stopRuns(runId?: string, reason = "stopped_by_user", opts: { seats?: Seats; events?: HumanCtx["events"] } = {}): Promise<number> {
  const rows = await db
    .update(simRuns)
    .set({ status: "stopped", stopReason: reason, finishedAt: sql`now()` })
    .where(and(inArray(simRuns.status, [...LIVE]), runId ? eq(simRuns.id, runId) : undefined))
    .returning({ id: simRuns.id });
  if (rows.length === 0) return 0;
  const seats = opts.seats ?? (await loadSeats());
  const events = opts.events ?? defaultEvents();
  for (const r of rows) await applyRunUndo(r.id, seats, events);
  return rows.length;
}

/** Live runs, oldest first: the cron tick's worklist. */
export async function liveRuns(limit: number) {
  return db.select({ id: simRuns.id }).from(simRuns).where(inArray(simRuns.status, [...LIVE])).orderBy(asc(simRuns.createdAt)).limit(limit);
}
