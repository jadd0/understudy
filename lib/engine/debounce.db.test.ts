import { asc, eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { messages, turns } from "@/db/schema";
import { processConversation } from "./process";
import { runTurn } from "./turn";
import { addMessage } from "./test-db";
import { rig, world, YES } from "./test-harness";

const turnsOf = (id: string) => db.select().from(turns).where(eq(turns.conversationId, id)).orderBy(asc(turns.createdAt), asc(turns.id));
const setTyping = (convId: string, on: boolean) =>
  db.execute(sql`update conversations set fan_typing_until = ${on ? sql`now() + interval '1 hour'` : sql`null`} where id = ${convId}`);
const jevInboundCalls = (r: ReturnType<typeof rig>) => r.decider.calls.filter((c) => c.keys.includes("intent"));

describe("the fan-side debounce", () => {
  test("burst_250ms_apart_gets_one_reply", async () => {
    const w = await world();
    const r = rig();
    const ids = [w.first.id];
    const bodies = ["b", "c"];
    r.onSleep.current = async () => {
      const body = bodies.shift();
      if (body) ids.push((await addMessage(w.conv.id, "fan", body)).id);
    };
    expect(await processConversation(w.conv.id, r.deps)).toBe(1);
    const ts = await turnsOf(w.conv.id);
    expect(ts).toHaveLength(1);
    expect([...ts[0].inboundIds].sort()).toEqual([...ids].sort());
    expect(ids).toHaveLength(3);
    expect(r.sleeps).toEqual([250, 250, 250]);
    expect(jevInboundCalls(r)).toHaveLength(1);
    expect(ts[0].jevIn).toMatchObject({ debounce: { waitedMs: 750, passes: 3, foldIns: 0 } });
  });

  test("typing_fan_holds_the_turn_until_he_stops", async () => {
    const w = await world();
    await setTyping(w.conv.id, true);
    const r = rig();
    let n = 0;
    r.onSleep.current = async () => {
      if (++n === 3) await setTyping(w.conv.id, false);
    };
    expect(await runTurn(w.conv.id, r.deps)).toMatchObject({ status: "committed" });
    expect(r.sleeps).toEqual([250, 250, 250]);
  });

  test("typing_never_holds_past_debounce_max", async () => {
    const w = await world({ "engine.debounce_max_ms": 1000 });
    await setTyping(w.conv.id, true);
    const r = rig();
    expect(await runTurn(w.conv.id, r.deps)).toMatchObject({ status: "committed" });
    expect(r.sleeps.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  test("still_typing_waits_and_reclassifies_whole_batch", async () => {
    const w = await world({}, "so basically my boss");
    const r = rig({
      script: { thread: (s) => ((s as { new_messages: string[] }).new_messages.length > 1 ? "same_topic" : "still_typing") },
    });
    let inserted: string | null = null;
    // B lands in the wait after Jev's first pass, longer than the debounce after A
    r.onSleep.current = async () => {
      if (inserted === null && r.decider.calls.length === 1) inserted = (await addMessage(w.conv.id, "fan", "just fired me lol")).id;
    };
    expect(await processConversation(w.conv.id, r.deps)).toBe(1);
    expect(jevInboundCalls(r)).toHaveLength(2);
    const ts = await turnsOf(w.conv.id);
    expect(ts).toHaveLength(1);
    expect(ts[0].inboundIds).toEqual([w.first.id, inserted]);
    expect(ts[0].jevIn).toMatchObject({ parsed: { thread: "same_topic" } });
  });

  test("still_typing_no_growth_keeps_classification", async () => {
    const w = await world({ "engine.debounce_max_ms": 1000 }, "so basically my boss");
    const r = rig({ script: { thread: "still_typing" } });
    expect(await runTurn(w.conv.id, r.deps)).toMatchObject({ status: "committed", route: "reply" });
    expect(jevInboundCalls(r)).toHaveLength(1);
    expect(r.sleeps.reduce((a, b) => a + b, 0)).toBe(1000);
    const [t] = await turnsOf(w.conv.id);
    expect(t.jevIn).toMatchObject({ parsed: { thread: "still_typing" } });
  });

  test("safety_fired_never_waits_for_still_typing", async () => {
    const w = await world({ "engine.debounce_max_ms": 1000 }, "ill find u and hurt u");
    const r = rig({ script: { thread: "still_typing", threat: YES } });
    expect(await runTurn(w.conv.id, r.deps)).toMatchObject({ route: "hard_stop" });
    expect(r.sleeps).toEqual([250]);
  });

  test("zero_debounce_never_loops", async () => {
    const w = await world({ "engine.debounce_ms": 0 }, "so basically my boss");
    await setTyping(w.conv.id, true);
    const r = rig({ script: { thread: "still_typing" } });
    expect(await runTurn(w.conv.id, r.deps)).toMatchObject({ status: "committed" });
    expect(r.sleeps).toEqual([]);
  });

  test("no_wait_or_fold_in_past_turn_budget", async () => {
    const w = await world({ "engine.turn_budget_ms": 0, "engine.debounce_max_ms": 1000 }, "so basically my boss");
    const r = rig({ script: { thread: "still_typing" } });
    expect(await runTurn(w.conv.id, r.deps)).toMatchObject({ status: "committed" });
    // only the quiet loop slept: the still_typing wait never started
    expect(r.sleeps).toEqual([250]);
  });
});

describe("still_typing and hardship", () => {
  test("hardship alone does not skip the still_typing wait", async () => {
    const w = await world({ "engine.debounce_max_ms": 1000 }, "so basically my landlord");
    const r = rig({ script: { thread: "still_typing", hardship: YES } });
    expect(await runTurn(w.conv.id, r.deps)).toMatchObject({ status: "committed" });
    expect(r.sleeps.reduce((a, b) => a + b, 0)).toBe(1000);
  });
});

describe("fold-in", () => {
  /** Inserts a late fan message when the first draft reaches verification. */
  function lateMessageDuringVerify(convId: string, out: { id: string | null }) {
    return {
      latch: async (_call: number, keys: string[]) => {
        if (out.id === null && keys.includes("on_persona")) out.id = (await addMessage(convId, "fan", "wait one more thing")).id;
      },
    };
  }

  test("complete_thought_late_message_folds_in_once", async () => {
    const w = await world({}, "guess what happened today");
    const late = { id: null as string | null };
    const r = rig({ decider: lateMessageDuringVerify(w.conv.id, late), replies: ["tell me", "ooh what happened"] });
    expect(await processConversation(w.conv.id, r.deps)).toBe(1);
    const ts = await turnsOf(w.conv.id);
    expect(ts).toHaveLength(1);
    expect(ts[0].inboundIds).toEqual([w.first.id, late.id]);
    expect(ts[0].draft).toBe("ooh what happened");
    expect(ts[0].jevOut).toContainEqual({ folded: true });
    expect(ts[0].jevIn).toMatchObject({ debounce: { foldIns: 1 } });
    const ai = (await db.select().from(messages).where(eq(messages.conversationId, w.conv.id))).filter((m) => m.sender === "ai" && m.status === "sent");
    expect(ai.map((m) => m.body)).toEqual(["ooh what happened"]);
  });

  test("fold_in_max_zero_keeps_second_turn", async () => {
    const w = await world({ "engine.fold_in_max": 0 }, "guess what happened today");
    const late = { id: null as string | null };
    const r = rig({ decider: lateMessageDuringVerify(w.conv.id, late), replies: ["tell me", "ooh what happened"] });
    expect(await runTurn(w.conv.id, r.deps)).toMatchObject({ status: "committed" });
    const ts = await turnsOf(w.conv.id);
    expect(ts[0].inboundIds).toEqual([w.first.id]);
    const [lateRow] = await db.select().from(messages).where(eq(messages.id, late.id!));
    expect(lateRow.turnId).toBeNull();
  });
});
