import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { simDeps } from "@/lib/sim/deps";
import { advanceRun, liveRuns } from "@/lib/sim/run";

export const maxDuration = 60;

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * Vercel Cron calls this every minute with `Authorization: Bearer $CRON_SECRET`. It rescues the simulator's runs: up to
 * `sim.max_concurrent_runs` live runs each advance for at most `sim.tick_budget_ms`. With `sim.enabled` off it touches nothing.
 */
export async function GET(request: Request) {
  if (!authorised(request)) return new NextResponse("unauthorised", { status: 401 });
  if (!(await getConfig<boolean>("sim.enabled"))) return NextResponse.json({ enabled: false, runs: 0, advanced: 0 });
  const [max, budgetMs] = await Promise.all([getConfig<number>("sim.max_concurrent_runs"), getConfig<number>("sim.tick_budget_ms")]);
  const deps = await simDeps();
  const runs = await liveRuns(max);
  const results = await Promise.all(runs.map((r) => advanceRun(r.id, deps, { budgetMs })));
  return NextResponse.json({ enabled: true, runs: runs.length, advanced: results.reduce((n, r) => n + r.advanced, 0) });
}
