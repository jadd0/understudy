import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "@/db/client";
import { conversations, messages, offers, turns } from "@/db/schema";
import { rig, world } from "../testing/harness";
import { sweep } from "./sweep";

vi.mock("@/lib/host/deps", async () => {
  const { rig: makeRig } = await import("../testing/harness");
  const r = makeRig();
  return { defaultDeps: async () => r.deps, chatter: async () => r.chatter };
});

// Other test files leave AI-mode conversations behind; the sweep is bounded, so park them.
beforeEach(async () => {
  await db.execute(sql`update conversations set mode = 'closed' where mode = 'ai'`);
});
afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe("sweep", () => {
  test("picks up an orphaned fan message older than the debounce and answers it once", async () => {
    const w = await world();
    const r = rig();
    const result = await sweep(r.ctx);
    expect(result.conversationsProcessed).toBe(1);
    expect(await db.select().from(turns).where(eq(turns.conversationId, w.conv.id))).toHaveLength(1);
    // nothing left to answer: a second sweep does nothing
    expect((await sweep(r.ctx)).conversationsProcessed).toBe(0);
  });

  test("leaves a message younger than the debounce, and a conversation a human owns", async () => {
    const young = await world({ "engine.debounce_ms": 600000 });
    await db.update(messages).set({ createdAt: sql`now()` }).where(eq(messages.id, young.first.id));
    const owned = await world({ "engine.debounce_ms": 600000 });
    await db.execute(sql`update conversations set mode = 'human_creator' where id = ${owned.conv.id}`);
    const r = rig();
    expect((await sweep(r.ctx)).conversationsProcessed).toBe(0);
    expect(await db.select().from(turns).where(eq(turns.conversationId, young.conv.id))).toHaveLength(0);
    expect(await db.select().from(turns).where(eq(turns.conversationId, owned.conv.id))).toHaveLength(0);
  });

  test("sweep_orders_oldest_first_and_respects_budget", async () => {
    const mk = async (ageSeconds: number) => {
      const w = await world();
      await db.update(messages).set({ createdAt: sql`now() - make_interval(secs => ${ageSeconds})` }).where(eq(messages.id, w.first.id));
      return w.conv.id;
    };
    const mid = await mk(300);
    const oldest = await mk(900);
    const newest = await mk(100);
    const r = rig();
    // each turn's debounce sleep moves the injected clock 25 s: two conversations fit in the 35 s start budget
    let t = 0;
    r.deps.clock = { now: () => t, sleep: async (ms) => { r.sleeps.push(ms); t += 25_000; } };
    const turnCount = async (id: string) => (await db.select().from(turns).where(eq(turns.conversationId, id))).length;

    expect((await sweep(r.ctx)).conversationsProcessed).toBe(2);
    expect(await turnCount(oldest)).toBe(1);
    expect(await turnCount(mid)).toBe(1);
    const created = async (id: string) => (await db.select().from(turns).where(eq(turns.conversationId, id)))[0].createdAt.getTime();
    expect(await created(oldest)).toBeLessThan(await created(mid));
    expect(await turnCount(newest)).toBe(0);
    // the next run takes what is left
    t = 0;
    expect((await sweep(r.ctx)).conversationsProcessed).toBe(1);
    expect(await turnCount(newest)).toBe(1);
  });

  test("clears an expired lease and then answers the conversation; a live lease is respected", async () => {
    const stale = await world();
    await db.execute(sql`update conversations set lease_token = gen_random_uuid(), lease_until = now() - interval '5 seconds' where id = ${stale.conv.id}`);
    const live = await world();
    await db.execute(sql`update conversations set lease_token = gen_random_uuid(), lease_until = now() + interval '60 seconds' where id = ${live.conv.id}`);
    const r = rig();
    const result = await sweep(r.ctx);
    expect(result.leasesCleared).toBe(1);
    expect(await db.select().from(turns).where(eq(turns.conversationId, stale.conv.id))).toHaveLength(1);
    expect(await db.select().from(turns).where(eq(turns.conversationId, live.conv.id))).toHaveLength(0);
    const [c] = await db.select().from(conversations).where(eq(conversations.id, live.conv.id));
    expect(c.leaseToken).not.toBeNull();
  });

  test("marks expired open offers and nothing else", async () => {
    const w = await world();
    await db.update(messages).set({ turnId: null, createdAt: sql`now()` }).where(eq(messages.id, w.first.id));
    const [stale] = await db.insert(offers).values({ conversationId: w.conv.id, itemId: w.itemA.id, priceCents: 1, expiresAt: sql`now() - interval '1 second'` }).returning();
    const [live] = await db.insert(offers).values({ conversationId: w.conv.id, itemId: w.itemB.id, priceCents: 1, expiresAt: sql`now() + interval '1 hour'` }).returning();
    const result = await sweep(rig().ctx);
    expect(result.offersExpired).toBeGreaterThanOrEqual(1);
    const status = async (id: string) => (await db.select().from(offers).where(eq(offers.id, id)))[0].status;
    expect(await status(stale.id)).toBe("expired");
    expect(await status(live.id)).toBe("open");
  });
});

describe("GET /api/cron/sweep", () => {
  const call = async (header?: string) => {
    const { GET } = await import("@/app/api/cron/sweep/route");
    return GET(new Request("http://localhost/api/cron/sweep", { headers: header ? { authorization: header } : {} }));
  };

  test("refuses a missing, wrong or unset secret", async () => {
    process.env.CRON_SECRET = "s3cret";
    expect((await call()).status).toBe(401);
    expect((await call("Bearer nope")).status).toBe(401);
    expect((await call("s3cret")).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await call("Bearer undefined")).status).toBe(401);
    expect((await call("Bearer ")).status).toBe(401);
  });

  test("runs the sweep with the right secret", async () => {
    process.env.CRON_SECRET = "s3cret";
    const res = await call("Bearer s3cret");
    expect(res.status).toBe(200);
    expect(Object.keys(await res.json()).sort()).toEqual(["conversationsProcessed", "handoffsAutoResolved", "leasesCleared", "offersExpired", "tsBreaches"]);
  });
});
