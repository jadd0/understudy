import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "@/db/client";
import { handoffs, messages } from "@/db/schema";
import { runEscalations } from "./escalation";
import { processConversation } from "../turn/process";
import { addMessage, getConversation } from "../testing/db";
import { rig, world } from "../testing/harness";
import { runTurn } from "../turn/run";
import type { HandoffQueue, HandoffReason } from "../types";

vi.mock("@/lib/host/deps", async () => {
  const { rig: makeRig } = await import("../testing/harness");
  const r = makeRig();
  return { defaultDeps: async () => r.deps, chatter: async () => r.chatter };
});

const CUSTOM = { intent: { value: "custom_request", probabilities: { custom_request: 0.9 } } };

// Other files leave handoffs behind and a pass is bounded: settle them so each test sees only its own.
beforeEach(async () => {
  await db.execute(sql`update handoffs set status = 'resolved', resolved_at = now() where status <> 'resolved'`);
  await db.execute(sql`update conversations set mode = 'closed' where mode = 'ai'`);
});

type World = Awaited<ReturnType<typeof world>>;

/** An unresolved handoff on the world's conversation, due `dueInSeconds` from now (negative: already late). */
async function hold(
  w: World,
  over: { queue?: HandoffQueue; reason?: HandoffReason; status?: "open" | "claimed"; dueInSeconds?: number; mode?: string } = {},
) {
  const mode = over.mode ?? ((over.queue ?? "creator") === "ts" ? "handoff_ts" : over.status === "claimed" ? "human_creator" : "handoff_creator");
  await db.execute(sql`update conversations set mode = ${mode}::conversation_mode where id = ${w.conv.id}`);
  const [h] = await db
    .insert(handoffs)
    .values({
      conversationId: w.conv.id,
      queue: over.queue ?? "creator",
      reason: over.reason ?? "custom_request",
      status: over.status ?? "open",
      claimedBy: over.status === "claimed" ? randomUUID() : null,
      dueAt: sql`now() + make_interval(secs => ${over.dueInSeconds ?? -60})` as unknown as Date,
    })
    .returning();
  return h;
}

const handoffOf = async (id: string) => (await db.select().from(handoffs).where(eq(handoffs.id, id)))[0];
const aiMessages = async (conversationId: string) =>
  db.select().from(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.sender, "ai")));

describe("runEscalations: creator-queue handoffs", () => {
  test("a due creator-queue handoff with an auto-resolve reason is resolved by sla and the AI answers the waiting message", async () => {
    const w = await world({}, "can you make a video just for me");
    const r = rig({ script: CUSTOM, replies: ["saw this one, i'll come back to you on it", "okay, tell me more about it"] });
    // the hold: the fan gets the filler and the chat waits for Juno
    expect(await runTurn(r.ctx, w.conv.id)).toMatchObject({ route: "hold_creator" });
    const [held] = await db.select().from(handoffs).where(eq(handoffs.conversationId, w.conv.id));
    expect(held.dueAt).not.toBeNull();
    // he writes again while he waits, and Juno never claims it
    await addMessage(w.conv.id, "fan", "hello?? anyone there", { ageSeconds: 3 });
    await db.execute(sql`update handoffs set due_at = now() - interval '1 minute' where id = ${held.id}`);

    const before = await getConversation(w.conv.id);
    // the sweep's pass: the fan's repeat is read as small talk now, so the AI answers him
    const answerer = rig({ replies: ["still here, what's up"] });
    expect(await runEscalations(answerer.ctx)).toEqual({ autoResolved: 1, tsBreaches: 0 });

    expect(await handoffOf(held.id)).toMatchObject({ status: "resolved", resolvedBy: "sla" });
    expect((await handoffOf(held.id)).resolvedAt).not.toBeNull();
    const after = await getConversation(w.conv.id);
    expect(after.mode).toBe("ai");
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.holdSuppressedUntil!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(after.holdSuppressedUntil!.getTime()).toBeLessThan(Date.now() + 25 * 3_600_000);
    // the AI answered the message that was waiting
    expect((await aiMessages(w.conv.id)).map((m) => m.body)).toEqual(["saw this one, i'll come back to you on it", "still here, what's up"]);
    expect(answerer.emitted.map((e) => e.event)).toEqual(expect.arrayContaining(["inbox.changed", "conversation.mode"]));
  });

  test("the fan repeating the request after the fallback is deflected, then held again once the window lapses", async () => {
    const w = await world({}, "can you make a video just for me");
    const r = rig({ script: CUSTOM });
    await runTurn(r.ctx, w.conv.id);
    await db.execute(sql`update handoffs set due_at = now() - interval '1 minute' where conversation_id = ${w.conv.id}`);
    await runEscalations(rig({ replies: ["unused"] }).ctx);
    expect((await getConversation(w.conv.id)).mode).toBe("ai");

    await addMessage(w.conv.id, "fan", "i really want that video", { ageSeconds: 4 });
    expect(await processConversation(r.ctx, w.conv.id)).toBe(1);
    expect((await db.select().from(handoffs).where(and(eq(handoffs.conversationId, w.conv.id), eq(handoffs.status, "open"))))).toHaveLength(0);
    expect((await getConversation(w.conv.id)).mode).toBe("ai");

    await db.execute(sql`update conversations set hold_suppressed_until = now() - interval '1 second' where id = ${w.conv.id}`);
    await addMessage(w.conv.id, "fan", "pretty please, that video", { ageSeconds: 4 });
    await processConversation(r.ctx, w.conv.id);
    expect((await getConversation(w.conv.id)).mode).toBe("handoff_creator");
  });

  test("a handoff that is not yet due is left alone", async () => {
    const w = await world();
    const h = await hold(w, { dueInSeconds: 600 });
    expect(await runEscalations(rig().ctx)).toEqual({ autoResolved: 0, tsBreaches: 0 });
    expect(await handoffOf(h.id)).toMatchObject({ status: "open", resolvedBy: null });
    expect((await getConversation(w.conv.id)).mode).toBe("handoff_creator");
  });

  test("a claimed handoff is never auto-resolved", async () => {
    // The mode a takeover leaves, and the mode as if the takeover had not reached the conversation row: the claim alone protects it.
    for (const mode of ["human_creator", "handoff_creator"]) {
      const w = await world();
      const h = await hold(w, { status: "claimed", mode });
      expect(await runEscalations(rig().ctx)).toEqual({ autoResolved: 0, tsBreaches: 0 });
      expect(await handoffOf(h.id)).toMatchObject({ status: "claimed", resolvedBy: null, resolvedAt: null });
      const conv = await getConversation(w.conv.id);
      expect(conv.mode).toBe(mode);
      expect(conv.holdSuppressedUntil).toBeNull();
      expect(await aiMessages(w.conv.id)).toHaveLength(0);
    }
  });

  test("engine_error is left for a human", async () => {
    const w = await world();
    const h = await hold(w, { reason: "engine_error" });
    expect(await runEscalations(rig().ctx)).toEqual({ autoResolved: 0, tsBreaches: 0 });
    expect(await handoffOf(h.id)).toMatchObject({ status: "open", resolvedBy: null });
    expect((await getConversation(w.conv.id)).mode).toBe("handoff_creator");
  });

  test("the reasons that may be settled are the config row, not a list in code", async () => {
    const w = await world({ "escalation.auto_resolve_reasons": ["engine_error"] });
    const a = await hold(w, { reason: "engine_error" });
    expect(await runEscalations(rig().ctx)).toMatchObject({ autoResolved: 1 });
    expect(await handoffOf(a.id)).toMatchObject({ status: "resolved", resolvedBy: "sla" });
    const other = await world({ "escalation.auto_resolve_reasons": ["engine_error"] });
    const b = await hold(other, { reason: "custom_request" });
    expect(await runEscalations(rig().ctx)).toMatchObject({ autoResolved: 0 });
    expect(await handoffOf(b.id)).toMatchObject({ status: "open" });
  });

  test("a high_value_alert is resolved without changing the mode", async () => {
    const w = await world();
    const h = await hold(w, { reason: "high_value_alert", mode: "ai" });
    const before = await getConversation(w.conv.id);
    expect(await runEscalations(rig().ctx)).toMatchObject({ autoResolved: 1 });
    expect(await handoffOf(h.id)).toMatchObject({ status: "resolved", resolvedBy: "sla" });
    const after = await getConversation(w.conv.id);
    expect(after).toMatchObject({ mode: "ai", version: before.version, holdSuppressedUntil: null });
  });

  test("two sweeps at once resolve a handoff once", async () => {
    const w = await world();
    const h = await hold(w);
    const results = await Promise.all([runEscalations(rig({ replies: ["a"] }).ctx), runEscalations(rig({ replies: ["b"] }).ctx)]);
    expect(results.map((x) => x.autoResolved).sort()).toEqual([0, 1]);
    expect(await handoffOf(h.id)).toMatchObject({ status: "resolved", resolvedBy: "sla" });
    // one hand-back (+1) and the one answer it triggered (+1)
    expect((await getConversation(w.conv.id)).version).toBe(2);
    expect(await aiMessages(w.conv.id)).toHaveLength(1);
  });

  test("a human takeover between the due check and the lock wins", async () => {
    const w = await world();
    const h = await hold(w);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const haveLock = new Promise<void>((r) => (locked = r));
    // The takeover: the conversation row is locked and the handoff claimed, but not committed yet.
    const takeover = db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from conversations where id = ${w.conv.id} for update`);
      locked();
      await held;
      await tx.execute(sql`update conversations set mode = 'human_creator', version = version + 1 where id = ${w.conv.id}`);
      await tx.execute(sql`update handoffs set status = 'claimed', claimed_by = ${randomUUID()}::uuid, claimed_at = now() where id = ${h.id}`);
    });
    await haveLock;
    const sweeping = runEscalations(rig({ replies: ["x"] }).ctx);
    // The sweep has read the still-open handoff and is now waiting on the conversation lock.
    for (let i = 0; i < 100; i++) {
      const { rows } = await db.execute(sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`);
      if ((rows[0] as { n: number }).n > 0) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    release();
    await takeover;
    expect(await sweeping).toEqual({ autoResolved: 0, tsBreaches: 0 });
    expect(await handoffOf(h.id)).toMatchObject({ status: "claimed", resolvedBy: null });
    expect(await getConversation(w.conv.id)).toMatchObject({ mode: "human_creator", holdSuppressedUntil: null });
    expect(await aiMessages(w.conv.id)).toHaveLength(0);
  });
});

describe("runEscalations: Trust & Safety handoffs", () => {
  test("a due T&S handoff is stamped and emitted once, and its mode is unchanged", async () => {
    const w = await world();
    const h = await hold(w, { queue: "ts", reason: "location_offplatform" });
    const r = rig();
    expect(await runEscalations(r.ctx)).toEqual({ autoResolved: 0, tsBreaches: 1 });
    const stamped = await handoffOf(h.id);
    expect(stamped).toMatchObject({ status: "open", resolvedBy: null });
    expect(stamped.slaBreachedAt).not.toBeNull();
    expect(r.emitted.filter((e) => e.event === "ts.sla_breached")).toEqual([
      { channel: "ops", event: "ts.sla_breached", payload: { conversationId: w.conv.id, handoffId: h.id, reason: "location_offplatform" } },
    ]);
    expect((await getConversation(w.conv.id)).mode).toBe("handoff_ts");

    // a second pass finds nothing new to say
    const again = rig();
    expect(await runEscalations(again.ctx)).toEqual({ autoResolved: 0, tsBreaches: 0 });
    expect(again.emitted.filter((e) => e.event === "ts.sla_breached")).toHaveLength(0);
    expect((await handoffOf(h.id)).slaBreachedAt).toEqual(stamped.slaBreachedAt);
  });

  test("a T&S handoff that is not due is not stamped", async () => {
    const w = await world();
    const h = await hold(w, { queue: "ts", reason: "threat", dueInSeconds: 900 });
    expect(await runEscalations(rig().ctx)).toEqual({ autoResolved: 0, tsBreaches: 0 });
    expect((await handoffOf(h.id)).slaBreachedAt).toBeNull();
  });

  test("a T&S breach is never resolved by the sweep, even if its reason were listed", async () => {
    for (const mode of ["handoff_ts", "handoff_creator"]) {
      const w = await world({ "escalation.auto_resolve_reasons": ["minor", "location_offplatform", "custom_request"] });
      const h = await hold(w, { queue: "ts", reason: "location_offplatform", mode });
      const r = rig({ replies: ["x"] });
      expect(await runEscalations(r.ctx)).toMatchObject({ autoResolved: 0, tsBreaches: 1 });
      expect(await handoffOf(h.id)).toMatchObject({ status: "open", resolvedBy: null, resolvedAt: null });
      expect((await handoffOf(h.id)).slaBreachedAt).not.toBeNull();
      expect(await getConversation(w.conv.id)).toMatchObject({ mode, holdSuppressedUntil: null });
      expect(await aiMessages(w.conv.id)).toHaveLength(0);
    }
  });
});
