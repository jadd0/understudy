import { grantWelcomeCredit, welcomeCreditCents } from "@/lib/wallet/grant";
import { randomUUID } from "node:crypto";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { db, withTx } from "@/db/client";
import { creators, simRuns, users } from "@/db/schema";
import { SIM_EMAIL_DOMAIN } from "@/lib/auth/demo-seats";
import { getConfig } from "@/lib/config";
import { loadPersonas, personaBySlug, touchesSharedState, type Persona } from "./persona";
import { newSeed, variant } from "./random";


export class SharedStateRefused extends Error {
  constructor(slug: string) {
    super(`persona "${slug}" changes the creator's shared state (AI switch, never-list); spawn it with includeShared`);
    this.name = "SharedStateRefused";
  }
}

export class SimDisabled extends Error {
  constructor() {
    super("the fan simulator is switched off (sim.enabled)");
    this.name = "SimDisabled";
  }
}

/** Who is spawning: an admin from the page, or the command line (no web session). */
export type Actor = { kind: "admin"; userId: string } | { kind: "cli" };

export interface SpawnOpts {
  batchId?: string;
  seed?: string;
  /** Injected so the declared date of birth is reproducible in tests. */
  now?: Date;
  personas?: Persona[];
  /** Allows a persona that changes the creator's shared state. Off unless a person asked for it. */
  includeShared?: boolean;
  /** Which creator the fan talks to; defaults to the seeded one. Tests pin their own. */
  creatorId?: string;
}

export interface Spawned {
  runId: string;
  fanId: string;
  persona: string;
  seed: string;
  status: "queued";
}

/** The creator the sim fans talk to: the seeded creator when its email is set, else the first creator. */
export async function simCreatorId(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const email = env.SEED_CREATOR_EMAIL?.trim().toLowerCase();
  if (email) {
    const [c] = await db.select({ id: creators.id }).from(creators).innerJoin(users, eq(users.id, creators.userId)).where(eq(users.email, email));
    if (c) return c.id;
  }
  const [first] = await db.select({ id: creators.id }).from(creators).orderBy(asc(creators.id)).limit(1);
  if (!first) throw new Error("no creator exists to talk to; run db:seed");
  return first.id;
}

/**
 * Makes one fresh sim fan (an adult by declaration, `is_sim`) and a queued run for it. Always queued: a run starts
 * when its trigger (CLI, `after()`, or the cron tick) leases it, and `advanceRun` holds it back while
 * `sim.max_concurrent_runs` runs are already live. Refused outright when `sim.enabled` is false.
 */
export async function spawnRun(personaSlug: string, mode: "demo" | "auto", actor: Actor, opts: SpawnOpts = {}): Promise<Spawned> {
  void actor;
  if (!(await getConfig<boolean>("sim.enabled"))) throw new SimDisabled();
  const persona = personaBySlug(personaSlug, opts.personas ?? loadPersonas());
  if (touchesSharedState(persona) && !opts.includeShared) throw new SharedStateRefused(persona.slug);
  const creatorId = opts.creatorId ?? (await simCreatorId());
  const seed = opts.seed ?? newSeed();
  const v = variant(persona, seed);
  const now = opts.now ?? new Date();
  const runId = randomUUID();
  // The sim declares an adult date of birth at sign-up; the minor persona does too, and gives itself away in chat.
  const declaredAge = persona.slug === "minor" ? 21 : Math.max(v.age, 18);
  const dob = new Date(Date.UTC(now.getUTCFullYear() - declaredAge, now.getUTCMonth(), Math.min(now.getUTCDate(), 28))).toISOString().slice(0, 10);

  const welcome = await getConfig<boolean>("sim.welcome_credit");
  const fanId = await withTx(async (tx) => {
    const [fan] = await tx
      .insert(users)
      .values({ email: `sim+${persona.slug}-${runId.slice(0, 8)}@${SIM_EMAIL_DOMAIN}`, name: v.name, role: "fan", dob, adultConfirmedAt: now, isSim: true })
      .returning({ id: users.id });
    // Every adult fan starts with the welcome credit; a sim fan does too, so unlocks work without Stripe.
    if (welcome) await grantWelcomeCredit(tx, fan.id, await welcomeCreditCents());
    await tx.insert(simRuns).values({ id: runId, personaSlug: persona.slug, mode, status: "queued", creatorId, fanId: fan.id, batchId: opts.batchId ?? null, seed, variant: { ...v, undo: [] } });
    return fan.id;
  });
  return { runId, fanId, persona: persona.slug, seed, status: "queued" };
}

/** Runs currently live (running or waiting for a human), which count against `sim.max_concurrent_runs`. */
export async function liveRunCount(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(simRuns).where(inArray(simRuns.status, ["running", "waiting_human"]));
  return row.n;
}
