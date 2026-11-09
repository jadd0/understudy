import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { simRuns, users, wallets } from "@/db/schema";
import { isSimEmail } from "@/lib/auth/demo-seats";
import { liveRunCount, SimDisabled, spawnRun } from "./spawn";
import { setSimConfig, simWorld, testPersona, freeBeat } from "./test-helpers";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const p = (slug = "casual-fan") => testPersona([freeBeat()], { slug });

describe("spawnRun", () => {
  test("spawn_creates_is_sim_adult_fan_and_queued_run", async () => {
    const w = await simWorld({ "sim.welcome_credit": true });
    const persona = p();
    const s = await spawnRun(persona.slug, "auto", { kind: "cli" }, { creatorId: w.creator.id, personas: [persona], seed: "abc", now: NOW });
    const [fan] = await db.select().from(users).where(eq(users.id, s.fanId));
    expect(fan).toMatchObject({ role: "fan", isSim: true, name: "Tess", flaggedAt: null });
    expect(fan.email).toBe(`sim+${persona.slug}-${s.runId.slice(0, 8)}@sim.understudy.test`);
    expect(isSimEmail(fan.email!)).toBe(true);
    expect(fan.adultConfirmedAt).toEqual(NOW);
    expect(fan.dob).toBe("1996-11-03");
    const [run] = await db.select().from(simRuns).where(eq(simRuns.id, s.runId));
    expect(run).toMatchObject({ status: "queued", mode: "auto", personaSlug: persona.slug, nextBeat: 0, creatorId: w.creator.id, fanId: s.fanId, seed: "abc" });
    expect(run.log).toEqual([]);
    // the welcome credit, like any adult fan, so unlock beats work without Stripe
    const [w2] = await db.select().from(wallets).where(eq(wallets.fanId, s.fanId));
    expect(w2?.balanceCents ?? 0).toBeGreaterThan(0);
  });

  test("the minor persona declares an adult date of birth and is still a sim fan", async () => {
    const w = await simWorld();
    const persona = testPersona([freeBeat()], { slug: "minor", free_play: false });
    const s = await spawnRun("minor", "auto", { kind: "cli" }, { creatorId: w.creator.id, personas: [persona], now: NOW });
    const [fan] = await db.select().from(users).where(eq(users.id, s.fanId));
    expect(fan.dob).toBe("2005-11-03");
    expect(fan.isSim).toBe(true);
  });

  test("spawn_refused_when_sim_disabled", async () => {
    const w = await simWorld({ "sim.enabled": false });
    const before = (await db.select().from(users).where(eq(users.isSim, true))).length;
    await expect(spawnRun("casual-fan", "auto", { kind: "cli" }, { creatorId: w.creator.id, personas: [p()] })).rejects.toBeInstanceOf(SimDisabled);
    expect((await db.select().from(users).where(eq(users.isSim, true))).length).toBe(before);
    await setSimConfig();
  });

  test("spawn_queues_past_max_concurrent", async () => {
    const w = await simWorld({ "sim.max_concurrent_runs": 1 });
    const persona = p();
    const a = await spawnRun(persona.slug, "auto", { kind: "cli" }, { creatorId: w.creator.id, personas: [persona] });
    await db.update(simRuns).set({ status: "running" }).where(eq(simRuns.id, a.runId));
    const live = await liveRunCount();
    expect(live).toBeGreaterThanOrEqual(1);
    const b = await spawnRun(persona.slug, "auto", { kind: "cli" }, { creatorId: w.creator.id, personas: [persona] });
    expect(b.status).toBe("queued");
    const [row] = await db.select().from(simRuns).where(eq(simRuns.id, b.runId));
    expect(row.status).toBe("queued");
    await db.update(simRuns).set({ status: "done" }).where(eq(simRuns.id, a.runId));
  });

  test("an unknown persona is refused before any row is made", async () => {
    const w = await simWorld();
    const before = (await db.select().from(users).where(eq(users.isSim, true))).length;
    await expect(spawnRun("nobody", "auto", { kind: "cli" }, { creatorId: w.creator.id, personas: [p()] })).rejects.toThrow(/unknown persona/);
    expect((await db.select().from(users).where(eq(users.isSim, true))).length).toBe(before);
  });
});
