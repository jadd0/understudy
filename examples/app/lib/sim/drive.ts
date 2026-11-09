import { getConfig } from "@/lib/config";
import type { SimDeps } from "./deps";
import { advanceRun, type AdvanceResult } from "./run";

/**
 * Advances one run until it ends or `wallMs` of wall time is spent: the loop the CLI and an admin's "Spawn" start.
 * The per-minute cron tick picks up whatever is left, so a host that cannot stay alive loses nothing.
 */
export async function driveRun(runId: string, deps: SimDeps, wallMs: number): Promise<AdvanceResult> {
  const until = Date.now() + wallMs;
  const leaseMs = await getConfig<number>("sim.lease_ms");
  let last: AdvanceResult = { advanced: 0, reason: "no_lease" };
  while (Date.now() < until) {
    last = await advanceRun(runId, deps, { budgetMs: Math.max(1000, until - Date.now()) });
    if (last.reason === "finished" || last.reason === "stopped" || last.reason === "lost_lease" || last.reason === "no_lease") break;
    // concurrency: wait for a slot; retry_later: the beat's rate limit; budget/waiting: just go round again.
    await deps.sleep(last.reason === "retry_later" ? leaseMs : 2000);
  }
  return last;
}
