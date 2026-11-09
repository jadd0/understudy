"use server";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { config, simRuns, users } from "@/db/schema";
import { getConfig } from "@/lib/config";
import { signIn } from "@/lib/auth";
import { captureSignInLink, isSimEmail } from "@/lib/auth/demo-seats";
import { requireRole } from "@/lib/auth/guards";
import { simDeps } from "@/lib/sim/deps";
import { driveRun } from "@/lib/sim/drive";
import { loadPersonas, NORMAL_MIX, touchesSharedState } from "@/lib/sim/persona";
import { newSeed, pickPersonas } from "@/lib/sim/random";
import { resetSim } from "@/lib/sim/reset";
import { advanceRun, liveRuns, stopRuns } from "@/lib/sim/run";
import { spawnRun, type Spawned } from "@/lib/sim/spawn";

/** How long a Spawn keeps driving its runs in this invocation; the per-minute cron tick carries on after that. */
const DRIVE_MS = 50_000;

/** How long one page tick advances each live run; the beat that is running when it lapses still finishes. */
const TICK_MS = 15_000;

/** The signed-in admin. Role comes from the session row, never from an argument; anyone else gets a 404. */
async function admin() {
  const user = await requireRole("admin");
  return { kind: "admin" as const, userId: user!.id! };
}

/** Spawns the runs and starts driving them. A refusal (simulator off, unknown persona) sends the admin back with the reason. */
async function spawnMany(slugs: string[], mode: "demo" | "auto", seed?: string, includeShared = false): Promise<void> {
  const actor = await admin();
  const batchId = randomUUID();
  const spawned: Spawned[] = [];
  try {
    for (const slug of slugs) spawned.push(await spawnRun(slug, mode, actor, { batchId, seed, includeShared }));
  } catch (e) {
    redirect(`/admin/sim?error=${encodeURIComponent((e as Error).name)}`);
  }
  // The runs are driven after the response so the page returns at once; the cron tick rescues anything left.
  after(async () => {
    const deps = await simDeps();
    await Promise.all(spawned.map((s) => driveRun(s.runId, deps, DRIVE_MS)));
  });
  revalidatePath("/admin/sim");
}

/** The "allow shared-state personas" box: personas that change Juno's real AI switch or never-list run only when it is ticked. */
const sharedOk = (f: FormData) => f.get("include_shared") === "on";

const modeOf = (v: FormDataEntryValue | null): "demo" | "auto" => (v === "demo" ? "demo" : "auto");

export async function spawnPersonaAction(formData: FormData): Promise<void> {
  const slug = String(formData.get("persona") ?? "");
  if (!loadPersonas().some((p) => p.slug === slug)) redirect("/admin/sim?error=unknown_persona");
  await spawnMany([slug], modeOf(formData.get("mode")), undefined, sharedOk(formData));
}

export async function spawnRandomAction(formData: FormData) {
  const n = Math.min(20, Math.max(1, Number.parseInt(String(formData.get("count") ?? "1"), 10) || 1));
  const seed = String(formData.get("seed") ?? "").trim() || newSeed();
  const picks = pickPersonas(loadPersonas(), n, seed, { includeMinor: formData.get("include_minor") === "on", includeShared: sharedOk(formData) });
  await spawnMany(picks.map((p) => p.slug), modeOf(formData.get("mode")), seed, sharedOk(formData));
}

export async function spawnMixAction(formData: FormData) {
  await spawnMany([...NORMAL_MIX], modeOf(formData.get("mode")));
}

export async function spawnAllAction(formData: FormData) {
  const shared = sharedOk(formData);
  await spawnMany(loadPersonas().filter((p) => shared || !touchesSharedState(p)).map((p) => p.slug), modeOf(formData.get("mode")), undefined, shared);
}

/** The kill switch, from the page: admin only. A freshly seeded database starts with it off. */
export async function setSimEnabledAction(formData: FormData): Promise<void> {
  await admin();
  const on = formData.get("enabled") === "on";
  await db.insert(config).values({ key: "sim.enabled", value: on }).onConflictDoUpdate({ target: [config.key, config.creatorId], set: { value: on, updatedAt: new Date() } });
  if (!on) await stopRuns(undefined, "disabled");
  revalidatePath("/admin/sim");
}

export async function stopAction(formData: FormData) {
  await admin();
  const runId = String(formData.get("run") ?? "");
  await stopRuns(runId || undefined);
  revalidatePath("/admin/sim");
}

export async function stopAllAction() {
  await admin();
  await stopRuns();
  revalidatePath("/admin/sim");
}

/**
 * The open admin page's tick: the same work as the per-minute cron (`/api/cron/sim`), with a short budget, so runs
 * progress while an admin watches even where no cron runs. The beats run after the response, so the page's other
 * buttons never queue behind a tick. Each run's lease means a run already being driven is skipped. Returns how many
 * runs were live, so the page can tell whether to keep ticking.
 */
export async function tickAction(): Promise<{ live: number }> {
  await admin();
  if (!(await getConfig<boolean>("sim.enabled"))) return { live: 0 };
  const runs = await liveRuns(await getConfig<number>("sim.max_concurrent_runs"));
  if (runs.length > 0) {
    after(async () => {
      const deps = await simDeps();
      await Promise.all(runs.map((r) => advanceRun(r.id, deps, { budgetMs: TICK_MS })));
    });
  }
  return { live: runs.length };
}

export async function resetAction() {
  await admin();
  await resetSim();
  revalidatePath("/admin/sim");
}

export type LinkResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * A one-time Auth.js sign-in link for a sim fan, so an admin can watch its chat from a second browser profile. Auth.js
 * makes the token and the session; the link is captured instead of mailed. A user that is not a sim fan is refused first.
 */
export async function openAsFanAction(runId: string): Promise<LinkResult> {
  await admin();
  const [row] = await db
    .select({ email: users.email, isSim: users.isSim, role: users.role })
    .from(simRuns)
    .innerJoin(users, eq(users.id, simRuns.fanId))
    .where(eq(simRuns.id, runId));
  if (!row || !row.isSim || row.role !== "fan" || !row.email || !isSimEmail(row.email)) return { ok: false, error: "not_a_sim_fan" };
  const email = row.email;
  const url = await captureSignInLink(email, () => signIn("resend", { email, redirect: false, redirectTo: "/" }));
  return url ? { ok: true, url } : { ok: false, error: "no_link" };
}
