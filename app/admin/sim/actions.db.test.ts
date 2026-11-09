import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "@/db/client";
import { config, simRuns, users } from "@/db/schema";
import { seatAwareSender } from "@/lib/auth/demo-seats";
import { makeAdmin } from "@/lib/conversations/test-helpers";
import { makeFan } from "@/lib/engine/test-db";
import { spawnRun } from "@/lib/sim/spawn";
import { setSimConfig, simWorld } from "@/lib/sim/test-helpers";

const session = { current: null as { user: { id: string } } | null };
const tasks: (() => Promise<unknown>)[] = [];
// Auth.js is replaced by a stand-in that hands the link to the same sender the product installs, so the capture is the real one.
vi.mock("@/lib/auth", () => ({
  auth: async () => session.current,
  signIn: async (_id: string, o: { email: string }) => seatAwareSender(() => { throw new Error("would have emailed"); })({ identifier: o.email, url: `https://app.test/cb?e=${o.email}` }),
}));
vi.mock("next/server", () => ({ after: (fn: () => Promise<unknown>) => void tasks.push(fn) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
// The page tick's beats are not under test here (run.db.test.ts covers advanceRun); only which runs it hands them to.
const advanced: { runId: string; budgetMs: number }[] = [];
vi.mock("@/lib/sim/run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sim/run")>()),
  advanceRun: async (runId: string, _deps: unknown, o: { budgetMs: number }) => (advanced.push({ runId, budgetMs: o.budgetMs }), { advanced: 0, reason: "budget" }),
}));
vi.mock("@/lib/sim/deps", () => ({ simDeps: async () => ({}) }));

const actions = await import("./actions");
const as = (u: { id: string }) => void (session.current = { user: { id: u.id } });
const form = (o: Record<string, string>) => Object.entries(o).reduce((f, [k, v]) => (f.set(k, v), f), new FormData());

beforeEach(() => {
  session.current = null;
  tasks.length = 0;
  advanced.length = 0;
});

const simRunCount = async () => (await db.select().from(simRuns)).length;
const redirectTarget = async (p: Promise<unknown>) => p.then(() => null, (e: { digest?: string }) => String(e.digest ?? e));

describe("admin sim actions", () => {
  test("creator_cannot_spawn_or_reset", async () => {
    const w = await simWorld();
    const sim = await spawnRun("casual-fan", "auto", { kind: "cli" }, { creatorId: w.creator.id });
    const before = await simRunCount();
    as({ id: w.creator.userId });
    for (const call of [
      () => actions.spawnPersonaAction(form({ persona: "casual-fan", mode: "auto" })),
      () => actions.spawnRandomAction(form({ count: "2" })),
      () => actions.spawnMixAction(form({})),
      () => actions.spawnAllAction(form({})),
      () => actions.resetAction(),
      () => actions.stopAllAction(),
    ]) {
      await expect(call()).rejects.toMatchObject({ digest: expect.stringMatching(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/) });
    }
    expect(await simRunCount()).toBe(before);
    expect(await db.select().from(users).where(eq(users.id, sim.fanId))).toHaveLength(1);
    expect(tasks).toHaveLength(0);
    // a fan and a signed-out visitor are refused too
    as(await makeFan());
    await expect(actions.resetAction()).rejects.toBeDefined();
    session.current = null;
    await expect(actions.spawnMixAction(form({}))).rejects.toBeDefined();
  });

  test("admin_spawn_inserts_queued_run", async () => {
    const w = await simWorld();
    const admin = await makeAdmin();
    as(admin);
    const before = await simRunCount();
    await actions.spawnPersonaAction(form({ persona: "casual-fan", mode: "demo" }));
    expect(await simRunCount()).toBe(before + 1);
    const rows = await db.select().from(simRuns).where(eq(simRuns.personaSlug, "casual-fan"));
    const mine = rows.find((r) => r.mode === "demo")!;
    expect(mine).toMatchObject({ status: "queued", nextBeat: 0 });
    const [fan] = await db.select().from(users).where(eq(users.id, mine.fanId));
    expect(fan).toMatchObject({ isSim: true, role: "fan" });
    // the run is driven after the response, by a task the page schedules
    expect(tasks).toHaveLength(1);
    // random spawns draw by seed and never the minor without the box ticked
    await actions.spawnRandomAction(form({ count: "6", seed: "fixed", mode: "auto" }));
    const randoms = (await db.select().from(simRuns)).filter((r) => r.seed === "fixed");
    expect(randoms).toHaveLength(6);
    expect(randoms.some((r) => r.personaSlug === "minor")).toBe(false);
    expect(new Set(randoms.map((r) => r.batchId)).size).toBe(1);
    void w;
  });

  test("an unknown persona or a switched-off simulator sends the admin back with the reason and writes nothing", async () => {
    await simWorld();
    as(await makeAdmin());
    const before = await simRunCount();
    expect(await redirectTarget(actions.spawnPersonaAction(form({ persona: "nobody", mode: "auto" })))).toContain("error=unknown_persona");
    await setSimConfig({ "sim.enabled": false });
    expect(await redirectTarget(actions.spawnPersonaAction(form({ persona: "casual-fan", mode: "auto" })))).toContain("error=SimDisabled");
    expect(await simRunCount()).toBe(before);
    await setSimConfig();
  });

  test("open_as_fan_refuses_non_sim_user", async () => {
    const w = await simWorld();
    as(await makeAdmin());
    const human = await makeFan();
    const [run] = await db.insert(simRuns).values({ personaSlug: "casual-fan", mode: "auto", creatorId: w.creator.id, fanId: human.id }).returning();
    expect(await actions.openAsFanAction(run.id)).toEqual({ ok: false, error: "not_a_sim_fan" });
    expect(await actions.openAsFanAction("00000000-0000-0000-0000-000000000000")).toEqual({ ok: false, error: "not_a_sim_fan" });
    // a sim fan gets the Auth.js link, captured instead of mailed
    const sim = await spawnRun("casual-fan", "auto", { kind: "cli" }, { creatorId: w.creator.id });
    const [simRun] = await db.select().from(simRuns).where(eq(simRuns.fanId, sim.fanId));
    const out = await actions.openAsFanAction(simRun.id);
    expect(out).toMatchObject({ ok: true });
    expect(out.ok && out.url).toContain("sim+casual-fan-");
    // a creator may not ask for one
    as({ id: w.creator.userId });
    await expect(actions.openAsFanAction(simRun.id)).rejects.toBeDefined();
  });

  test("the kill switch is an admin action that stores sim.enabled, and a creator cannot flip it", async () => {
    const w = await simWorld();
    as({ id: w.creator.userId });
    await expect(actions.setSimEnabledAction(form({ enabled: "on" }))).rejects.toBeDefined();
    as(await makeAdmin());
    await actions.setSimEnabledAction(form({ enabled: "off" }));
    const row = async () => (await db.select().from(config).where(eq(config.key, "sim.enabled")))[0].value;
    expect(await row()).toBe(false);
    expect(await redirectTarget(actions.spawnPersonaAction(form({ persona: "casual-fan", mode: "auto" })))).toContain("error=SimDisabled");
    await actions.setSimEnabledAction(form({ enabled: "on" }));
    expect(await row()).toBe(true);
  });

  test("shared_state_personas_need_the_box_and_are_left_out_of_spawn_all", async () => {
    await simWorld();
    as(await makeAdmin());
    const before = await db.select().from(simRuns);
    // the per-persona button for a shared-state persona carries the box; Spawn all without it leaves them out
    await actions.spawnAllAction(form({ mode: "auto" }));
    const fresh = (await db.select().from(simRuns)).filter((r) => !before.some((b) => b.id === r.id));
    expect(fresh.length).toBeGreaterThan(10);
    expect(fresh.some((r) => ["toggle-tester", "nosy"].includes(r.personaSlug))).toBe(false);
    // a shared-state persona asked for without the box is refused and writes nothing
    expect(await redirectTarget(actions.spawnPersonaAction(form({ persona: "nosy", mode: "auto" })))).toContain("error=SharedStateRefused");
    expect((await db.select().from(simRuns)).filter((r) => r.personaSlug === "nosy")).toHaveLength(0);
    // ticked, it spawns
    await actions.spawnPersonaAction(form({ persona: "nosy", mode: "auto", include_shared: "on" }));
    expect((await db.select().from(simRuns)).filter((r) => r.personaSlug === "nosy")).toHaveLength(1);
  });

  test("the page tick advances live runs after the response, for an admin only, and does nothing with the simulator off", async () => {
    const w = await simWorld({ "sim.max_concurrent_runs": 10_000 });
    const live = await spawnRun("casual-fan", "demo", { kind: "cli" }, { creatorId: w.creator.id });
    const [run] = await db.select().from(simRuns).where(eq(simRuns.fanId, live.fanId));
    // a creator, a fan and a signed-out visitor are refused before anything is scheduled
    as({ id: w.creator.userId });
    await expect(actions.tickAction()).rejects.toMatchObject({ digest: expect.stringMatching(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/) });
    as(await makeFan());
    await expect(actions.tickAction()).rejects.toBeDefined();
    session.current = null;
    await expect(actions.tickAction()).rejects.toBeDefined();
    expect(tasks).toHaveLength(0);

    as(await makeAdmin());
    const out = await actions.tickAction();
    expect(out.live).toBeGreaterThan(0);
    // nothing is driven inside the action itself, so the page's other buttons never wait on a tick
    expect(advanced).toHaveLength(0);
    expect(tasks).toHaveLength(1);
    await tasks[0]();
    expect(advanced.find((a) => a.runId === run.id)).toMatchObject({ budgetMs: expect.any(Number) });

    // with the kill switch off the tick schedules nothing
    tasks.length = 0;
    await setSimConfig({ "sim.enabled": false });
    expect(await actions.tickAction()).toEqual({ live: 0 });
    expect(tasks).toHaveLength(0);
    await setSimConfig();
  });
});
