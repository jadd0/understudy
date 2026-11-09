import { describe, expect, test } from "vitest";
import { ThreadSchema } from "@/lib/evals/threads";
import { exportThread } from "./export";
import { loadPersonas, type Beat } from "./persona";
import { emptyScore, type BeatResult } from "./score";
import { testPersona } from "./test-helpers";

const result = (index: number, kind: Beat["kind"], sent?: string[], status: BeatResult["status"] = "done"): BeatResult => ({
  index, kind, label: kind, status, at: "2026-11-03T12:00:00.000Z", score: emptyScore(), ...(sent ? { sent } : {}),
});
const REPLY = { queue: "none" as const, route: "reply" as const };
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const say = (_text?: string): Beat => ({ kind: "say", checkpoint: "c", example: "e", expect: REPLY, row: "smalltalk" });

describe("export to 9b threads", () => {
  test("export_validates_against_9b_ThreadSchema", () => {
    const persona = testPersona([say("a"), { kind: "burst", texts: ["x", "y"], expect: { ...REPLY, turns: 1 } }], { slug: "export-me", goal: "be exported" });
    const t = exportThread(persona, [result(0, "say", ["hello there"]), result(1, "burst", ["x", "y"])])!;
    expect(ThreadSchema.safeParse(t).success).toBe(true);
    expect(t.id).toBe("sim-export-me");
    expect(t.turns.map((x) => x.say)).toEqual([["hello there"], ["x", "y"]]);
    expect(t.turns[0].row).toBe("smalltalk");
    expect(t.turns[1].expect.turns).toBe(1);
  });

  test("money_beats_become_setup", () => {
    const persona = testPersona([{ kind: "topup", cents: 1000 }, { kind: "topup", cents: 500 }, say("a")]);
    const t = exportThread(persona, [result(0, "topup"), result(1, "topup"), result(2, "say", ["hi"])])!;
    expect(t.setup).toEqual({ wallet_cents: 1500 });
    expect(t.turns).toHaveLength(1);
  });

  test("thread_cut_at_first_unexportable_beat", () => {
    const persona = testPersona([say("a"), say("b"), { kind: "unlock", target: "latest", result: "unlocked" }, say("c")]);
    const t = exportThread(persona, [result(0, "say", ["one"]), result(1, "say", ["two"]), result(2, "unlock"), result(3, "say", ["three"])])!;
    expect(t.turns.map((x) => x.say[0])).toEqual(["one", "two"]);
    // a human beat, a tip and a nudge cut the same way
    for (const beat of [{ kind: "human", action: "takeover" }, { kind: "tip", cents: 100 }, { kind: "nudge", what: "expire_offer" }] as Beat[]) {
      const p = testPersona([say("a"), beat, say("c")]);
      expect(exportThread(p, [result(0, "say", ["one"]), result(1, beat.kind), result(2, "say", ["three"])])!.turns).toHaveLength(1);
    }
  });

  test("a blocked or unsent line ends the thread, and nothing exportable gives null", () => {
    const persona = testPersona([say("a"), say("b")]);
    expect(exportThread(persona, [result(0, "say", ["one"]), result(1, "say", ["blocked text"], "blocked")])!.turns).toHaveLength(1);
    expect(exportThread(persona, [result(0, "say", undefined, "refused")])).toBeNull();
    expect(exportThread(persona, [])).toBeNull();
  });

  test("every roster persona exports a valid thread from a run that did all its message beats", () => {
    const exported = loadPersonas().map((p) => {
      const results = p.beats.map((b, i) => result(i, b.kind, b.kind === "burst" ? b.texts : b.kind === "say" || b.kind === "free" || b.kind === "line" ? [`line ${i}`] : undefined));
      return exportThread(p, results);
    });
    // only a persona whose very first beat is a human action has nothing to export
    expect(loadPersonas().filter((_, i) => exported[i] === null).map((p) => p.slug)).toEqual(["toggle-tester"]);
    expect(new Set(exported.flatMap((t) => (t ? [t.id] : []))).size).toBe(exported.length - 1);
  });
});
