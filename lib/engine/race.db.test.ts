import { asc, eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db, withTx } from "@/db/client";
import { handoffs, messages, offers, turns, users } from "@/db/schema";
import { unlockOffer } from "@/lib/wallet/unlock";
import { fund } from "@/lib/wallet/test-helpers";
import { acquireLease, commitTurn, handBack, type CommitPlan } from "./lease";
import { processConversation } from "./process";
import { runTurn } from "./turn";
import { addMessage, getConversation } from "./test-db";
import { deferred, rig, world, YES } from "./test-harness";

const turnsOf = (id: string) => db.select().from(turns).where(eq(turns.conversationId, id)).orderBy(asc(turns.createdAt), asc(turns.id));
const msgsOf = (id: string) => db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(asc(messages.createdAt), asc(messages.id));
const takeoverSql = (id: string) =>
  db.execute(sql`update conversations set mode = 'human_creator', version = version + 1 where id = ${id}`);

/** A latch that holds the first provider call until the test lets go. */
function hold() {
  const reached = deferred();
  const gate = deferred();
  return {
    reached: reached.promise,
    release: gate.resolve,
    latch: async (n: number) => {
      if (n === 1) {
        reached.resolve();
        await gate.promise;
      }
    },
  };
}

describe("races", () => {
  test("1. a takeover during generation: the draft is superseded and the fan sees only the human's message", async () => {
    const w = await world();
    const h = hold();
    const r = rig({ generator: { latch: h.latch }, replies: ["bot draft"] });
    const running = runTurn(w.conv.id, r.deps);
    await h.reached;
    await takeoverSql(w.conv.id);
    await addMessage(w.conv.id, "creator", "juno here, hi!");
    h.release();

    expect(await running).toMatchObject({ status: "superseded" });
    const all = await msgsOf(w.conv.id);
    const draft = all.find((m) => m.sender === "ai");
    expect(draft).toMatchObject({ body: "bot draft", status: "superseded" });
    expect(all.filter((m) => m.status === "sent" && m.sender !== "fan").map((m) => m.body)).toEqual(["juno here, hi!"]);
    expect((await turnsOf(w.conv.id))[0].outcome).toBe("superseded");
    expect(all.find((m) => m.id === w.first.id)?.turnId).toBeNull();
    expect(r.emitted).toHaveLength(0);
    expect(await getConversation(w.conv.id)).toMatchObject({ mode: "human_creator", leaseToken: null });
  });

  test("2. a hard stop that loses the race to a takeover still flags the user and opens the handoff", async () => {
    const w = await world({}, "im 15 and i want to die");
    const h = hold();
    const r = rig({ script: { minor: YES, self_harm: YES }, decider: { latch: async (n) => h.latch(n) } });
    const running = runTurn(w.conv.id, r.deps);
    await h.reached;
    await takeoverSql(w.conv.id);
    h.release();

    expect(await running).toMatchObject({ status: "superseded" });
    const [fan] = await db.select().from(users).where(eq(users.id, w.fan.id));
    expect(fan.flaggedAt).not.toBeNull();
    expect(await db.select().from(handoffs).where(eq(handoffs.conversationId, w.conv.id))).toMatchObject([
      { queue: "ts", reason: "minor", status: "open" },
    ]);
    expect(await getConversation(w.conv.id)).toMatchObject({ mode: "handoff_ts" });
    const [t] = await turnsOf(w.conv.id);
    expect(t.outcome).toBe("superseded");
    expect(t.handoffId).not.toBeNull();
    // the crisis resources still reach the fan: the template is stored sent, not superseded
    const ai = (await msgsOf(w.conv.id)).filter((m) => m.sender === "ai");
    expect(ai).toMatchObject([{ status: "sent", deliverAt: null }]);
    expect(ai[0].body).toContain("988");
    expect(r.emitted.map((e) => e.event)).toContain("message.created");
  });

  test("crisis_template_sent_even_when_takeover_wins", async () => {
    const w = await world({}, "i want to end it");
    const h = hold();
    const r = rig({ script: { self_harm: YES }, decider: { latch: async (n) => h.latch(n) } });
    const running = runTurn(w.conv.id, r.deps);
    await h.reached;
    await takeoverSql(w.conv.id);
    h.release();
    expect(await running).toMatchObject({ status: "superseded" });
    const sent = (await msgsOf(w.conv.id)).filter((m) => m.sender === "ai" && m.status === "sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain("988");
    expect(r.emitted.filter((e) => e.event === "message.created")).toHaveLength(1);
  });

  test("3. two processConversation calls at once, the first held: one turn", async () => {
    const w = await world();
    const h = hold();
    const r = rig({ generator: { latch: h.latch } });
    const first = processConversation(w.conv.id, r.deps);
    await h.reached;
    expect(await processConversation(w.conv.id, r.deps)).toBe(0);
    h.release();
    expect(await first).toBe(1);
    expect(await turnsOf(w.conv.id)).toHaveLength(1);
    expect((await msgsOf(w.conv.id)).filter((m) => m.sender === "ai" && m.status === "sent")).toHaveLength(1);
  });

  test("4. a burst of three inside the debounce: one turn answering all three", async () => {
    const w = await world({}, "hey");
    const r = rig();
    const ids = [w.first.id];
    r.onSleep.current = async () => {
      for (const body of ["are you there", "hello??"]) {
        ids.push((await addMessage(w.conv.id, "fan", body)).id);
        // every send schedules its own processConversation; none may start a second turn
        expect(await processConversation(w.conv.id, r.deps)).toBe(0);
      }
      r.onSleep.current = null;
    };
    expect(await processConversation(w.conv.id, r.deps)).toBe(1);
    const ts = await turnsOf(w.conv.id);
    expect(ts).toHaveLength(1);
    expect([...ts[0].inboundIds].sort()).toEqual([...ids].sort());
    // one sleep per growth of the batch, then one quiet pass
    expect(r.sleeps).toEqual([250, 250]);
  });

  test("5a. with fold-ins off, a fan message during a turn is answered by a second turn afterwards", async () => {
    const w = await world({ "engine.fold_in_max": 0 });
    const h = hold();
    const r = rig({ generator: { latch: h.latch }, replies: ["first answer", "second answer"] });
    const running = processConversation(w.conv.id, r.deps);
    await h.reached;
    const late = await addMessage(w.conv.id, "fan", "one more thing");
    h.release();
    expect(await running).toBe(2);
    const ts = await turnsOf(w.conv.id);
    expect(ts.map((t) => t.inboundIds)).toEqual([[w.first.id], [late.id]]);
    expect((await msgsOf(w.conv.id)).filter((m) => m.sender === "ai").map((m) => m.body)).toEqual(["first answer", "second answer"]);
  });

  test("5b. a fan message during generation is folded into the same turn", async () => {
    const w = await world();
    const h = hold();
    const r = rig({ generator: { latch: h.latch }, replies: ["first answer", "second answer"] });
    const running = processConversation(w.conv.id, r.deps);
    await h.reached;
    const late = await addMessage(w.conv.id, "fan", "one more thing");
    h.release();
    expect(await running).toBe(1);
    const ts = await turnsOf(w.conv.id);
    expect(ts).toHaveLength(1);
    expect([...ts[0].inboundIds].sort()).toEqual([w.first.id, late.id].sort());
    expect((await msgsOf(w.conv.id)).filter((m) => m.sender === "ai").map((m) => m.body)).toEqual(["second answer"]);
    expect(ts[0].jevOut).toContainEqual({ folded: true });
  });

  test("6. after a hand-back, messages a human already handled are not answered again, a later one is (handback_answers_message_after_last_human)", async () => {
    const w = await world({}, "m1");
    await takeoverSql(w.conv.id);
    await addMessage(w.conv.id, "fan", "m2", { ageSeconds: 4 });
    await addMessage(w.conv.id, "fan", "m3", { ageSeconds: 3 });
    await addMessage(w.conv.id, "creator", "juno answered", { ageSeconds: 2 });
    const m4 = await addMessage(w.conv.id, "fan", "m4, after her answer", { ageSeconds: 1 });
    await handBack(w.conv.id);
    const fresh = await addMessage(w.conv.id, "fan", "m5, new", { ageSeconds: 0 });

    const r = rig();
    expect(await processConversation(w.conv.id, r.deps)).toBe(1);
    const answered = (await turnsOf(w.conv.id)).filter((t) => t.outcome === "replied");
    expect(answered.map((t) => t.inboundIds)).toEqual([[m4.id, fresh.id]]);
  });

  test("7. a re-lease after the lease expired: the original commit loses, is superseded, and leaves no offer", async () => {
    const w = await world({ "pitch.min_gap_rounds": 0 });
    const aReached = deferred();
    const aGate = deferred();
    const bReached = deferred();
    const bGate = deferred();
    const r = rig({
      replies: ["A draft", "B draft"],
      generator: {
        latch: async (n) => {
          if (n === 1) {
            aReached.resolve();
            await aGate.promise;
          } else if (n === 2) {
            bReached.resolve();
            await bGate.promise;
          }
        },
      },
    });
    const a = processConversation(w.conv.id, r.deps);
    await aReached.promise;
    await db.execute(sql`update conversations set lease_until = now() - interval '1 second' where id = ${w.conv.id}`);

    // the sweep (or the next send) takes the expired lease; both turns now sit at the model
    const b = processConversation(w.conv.id, r.deps);
    await bReached.promise;
    // the original finishes first, holding a lease that is no longer the conversation's
    aGate.resolve();
    expect(await a).toBe(0);
    bGate.resolve();
    expect(await b).toBe(1);

    const ts = await turnsOf(w.conv.id);
    expect(ts.map((t) => t.outcome).sort()).toEqual(["replied", "superseded"]);
    const winner = ts.find((t) => t.outcome === "replied")!;
    const loser = ts.find((t) => t.outcome === "superseded")!;
    const os = await db.select().from(offers).where(eq(offers.conversationId, w.conv.id));
    expect(os.map((o) => o.turnId)).toEqual([winner.id]);
    expect(loser.offerId).toBeNull();
    const ai = (await msgsOf(w.conv.id)).filter((m) => m.sender === "ai");
    expect(ai.map((m) => [m.body, m.status]).sort()).toEqual([["A draft", "superseded"], ["B draft", "sent"]]);
    expect(await getConversation(w.conv.id)).toMatchObject({ mode: "ai", leaseToken: null });
  });
});

/** Postgres's SQLSTATE for a detected deadlock; drizzle may wrap the driver's error in `cause`. */
const DEADLOCK = "40P01";
const sqlState = (e: unknown): string | undefined =>
  (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;

/** Polls until `count` is at least one; a lock wait the test expects must show up within a few seconds. */
async function until(what: string, count: () => Promise<number>) {
  for (let i = 0; i < 200; i++) {
    if ((await count()) > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const blockedBy = async (pid: number) =>
  Number(
    ((await db.execute(sql`select count(*)::int as n from pg_stat_activity a where ${pid}::int = any(pg_blocking_pids(a.pid))`)).rows[0] as { n: number }).n,
  );
const blockedBehind = async (pid: number) =>
  Number(
    (
      (await db.execute(sql`
        select count(*)::int as n from pg_stat_activity a, pg_stat_activity b
        where ${pid}::int = any(pg_blocking_pids(b.pid)) and b.pid = any(pg_blocking_pids(a.pid))`)).rows[0] as { n: number }
    ).n,
  );

describe("lock order", () => {
  test("a hard stop and an unlock on the same conversation at once both complete: no deadlock", async () => {
    const w = await world({}, "im 15");
    await fund(w.fan.id, 5000);
    const [offer] = await db
      .insert(offers)
      .values({ conversationId: w.conv.id, itemId: w.itemA.id, priceCents: 1777, expiresAt: sql`now() + interval '1 hour'` })
      .returning();
    // An AI bubble the fan has not seen yet carries the offer, so the hard stop's supersede step writes that offer row.
    await db.insert(messages).values({
      conversationId: w.conv.id,
      sender: "ai",
      body: "look what i have",
      offerId: offer.id,
      deliverAt: sql`now() + interval '1 minute'`,
    });
    const lease = await acquireLease(w.conv.id, 60_000);
    expect(lease).not.toBeNull();
    const plan: CommitPlan = {
      outcome: "hard_stop",
      turn: {
        inboundIds: [w.first.id],
        route: "hard_stop",
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
      },
      reply: null,
      offer: null,
      declineOfferId: null,
      handoff: { queue: "ts", reason: "minor" },
      setMode: "handoff_ts",
      hardStop: { reason: "minor", flagUser: true },
      alert: false,
      hardshipCooldownHours: null,
      typing: { cps: 20, maxMs: 0, gapMs: 0 },
    };

    // A third transaction holds the wallet so the two are forced to interleave: the unlock takes its first locks
    // and waits on the wallet, the hard stop starts and waits behind the unlock, then the wallet is let go. Under
    // the old order (unlock: offer, wallet, user; hard stop: user, then offers) that is a deadlock.
    const release = deferred();
    const pid = deferred<number>();
    const holder = withTx(async (tx) => {
      await tx.execute(sql`select 1 from wallets where fan_id = ${w.fan.id} for update`);
      pid.resolve(Number(((await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0] as { pid: number }).pid));
      await release.promise;
    });
    const holderPid = await pid.promise;
    let settled: PromiseSettledResult<unknown>[];
    try {
      const unlocking = unlockOffer(w.fan.id, offer.id);
      await until("the unlock to wait on the wallet", () => blockedBy(holderPid));
      const stopping = commitTurn(lease!, plan);
      await until("the hard stop to wait behind the unlock", () => blockedBehind(holderPid));
      release.resolve();
      settled = await Promise.allSettled([unlocking, stopping]);
    } finally {
      release.resolve();
      await holder;
    }

    const failures = settled.flatMap((r) => (r.status === "rejected" ? [sqlState(r.reason) ?? String(r.reason)] : []));
    expect(failures).not.toContain(DEADLOCK);
    expect(failures).toEqual([]);
    const [o] = await db.select().from(offers).where(eq(offers.id, offer.id));
    expect(o.status).toBe("accepted");
    const [fan] = await db.select().from(users).where(eq(users.id, w.fan.id));
    expect(fan.flaggedAt).not.toBeNull();
    expect(await db.select().from(handoffs).where(eq(handoffs.conversationId, w.conv.id))).toMatchObject([
      { queue: "ts", reason: "minor", status: "open" },
    ]);
    expect(await getConversation(w.conv.id)).toMatchObject({ mode: "handoff_ts" });
  });
});
