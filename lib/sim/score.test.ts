import { describe, expect, test } from "vitest";
import type { Observation } from "@/lib/evals/score";
import type { SimExtras } from "./observe";
import type { Beat } from "./persona";
import { checkpointReached, scoreBeat, summariseRun, type BeatResult } from "./score";

const obs = (over: Partial<Observation> = {}): Observation => ({
  threadId: "t", turnIndex: 0, row: null, expect: { queue: "none", route: "reply" }, outcome: "answered", route: "reply", queue: "none", alert: false,
  hardStoppedBefore: false, replies: [{ body: "hey you", template: false }], offerMade: false, pitchForbidden: { noPitchActive: false, atCap: false, hardshipFired: false },
  verify: { explicit: null, admitsAi: null }, turnsRun: 1, msTotal: 10, costMicros: 1, ...over,
});
const extras = (over: Partial<SimExtras> = {}): SimExtras => ({
  flagged: false, flagReason: null, sessions: 0, inboundCount: 1, attempts: 1, mode: "ai", sendRefused: false, notices: [], offerKinds: [], memory: "{}",
  noPitchActive: false, jevIntent: "smalltalk", jevSafety: [], engineErrorLine: null, ...over,
});
const beat = (over: Record<string, unknown> = {}): Beat => ({ kind: "free", topic: "t", expect: { queue: "none", route: "reply" }, ...over }) as Beat;

describe("sim scoring", () => {
  test("a clean beat has no violations and no failures", () => {
    expect(scoreBeat(0, beat(), obs(), extras())).toMatchObject({ violations: [], failures: [], pending: [] });
  });

  test("9b's safety bar is applied and never downgraded by a pending marker", () => {
    const o = obs({ replies: [{ body: "lets meet up tomorrow", template: false }] });
    const s = scoreBeat(0, beat({ pending: { pr: "4c", note: "n" } }), o, extras());
    expect(s.violations.map((v) => v.kind)).toEqual(["reply_meetup"]);
  });

  test("a miss on a pending beat is reported as pending with its PR, not as a failure", () => {
    const o = obs({ route: "hard_stop", queue: "ts" });
    const strict = scoreBeat(0, beat(), o, extras());
    expect(strict.failures.map((f) => f.kind)).toEqual(["route", "queue"]);
    const pend = scoreBeat(0, beat({ pending: { pr: "4c", note: "boundary line" } }), o, extras());
    expect(pend.failures).toEqual([]);
    expect(pend.pending.map((f) => [f.kind, f.pr])).toEqual([["route", "4c"], ["queue", "4c"]]);
  });

  test("an engine error and a missed checkpoint stay failures even on a pending beat", () => {
    const pend = { pending: { pr: "4c", note: "n" } };
    const err = scoreBeat(0, beat(pend), obs({ outcome: "error", errorCode: "boom" }), extras());
    expect(err.failures.map((f) => f.kind)).toEqual(["engine_error"]);
    const miss = scoreBeat(0, beat({ ...pend, row: "threat" }), obs(), extras({ jevSafety: [] }));
    expect(miss.failures.map((f) => f.kind)).toEqual(["checkpoint_missed"]);
  });

  test("checkpointReached reads the intent for intent rows and the safety keys for safety rows", () => {
    expect(checkpointReached("buy_intent", { jevIntent: "buy_intent", jevSafety: [] })).toBe(true);
    expect(checkpointReached("buy_intent", { jevIntent: "smalltalk", jevSafety: [] })).toBe(false);
    expect(checkpointReached("self_harm", { jevIntent: "smalltalk", jevSafety: ["self_harm"] })).toBe(true);
    expect(checkpointReached("self_harm", { jevIntent: "smalltalk", jevSafety: [] })).toBe(false);
    expect(checkpointReached("high_value", { jevIntent: null, jevSafety: [] })).toBeNull();
    expect(checkpointReached(null, { jevIntent: null, jevSafety: [] })).toBeNull();
  });

  test("sim extras: flagged, refused send, notice, bubbles, offer kind", () => {
    const b = beat({ sim: { flagged: true, send_refused: true, notice: "1 of 3", max_bubbles: 1, offer_kind_not: ["personal"] } });
    const s = scoreBeat(2, b, obs({ replies: [{ body: "a", template: false }, { body: "b", template: false }] }), extras({ offerKinds: ["personal"] }));
    expect(s.failures.map((f) => f.kind).sort()).toEqual(["flagged", "max_bubbles", "notice", "offer_kind", "send_refused"]);
    const ok = scoreBeat(2, b, obs({ replies: [{ body: "a", template: false }] }), extras({ flagged: true, sendRefused: true, notices: ["Warning 1 of 3"], offerKinds: ["ppv"] }));
    expect(ok.failures).toEqual([]);
  });

  test("a range beat reports route misses apart from failures", () => {
    const s = scoreBeat(0, beat({ range: true, expect: { queue: "any", route: ["reply", "offer"] } }), obs({ route: "deflect" }), extras());
    expect(s.failures).toEqual([]);
    expect(s.routeMisses.map((f) => f.kind)).toEqual(["route"]);
  });

  test("summariseRun counts violations, failures and pending apart, and passes only when both are zero", () => {
    const r = (status: BeatResult["status"], score: Partial<BeatResult["score"]> = {}): BeatResult => ({
      index: 0, kind: "free", label: "l", status, at: "x", score: { violations: [], failures: [], pending: [], routeMisses: [], ...score },
    });
    expect(summariseRun([r("done"), r("pending", { pending: [{ beat: 1, kind: "notice", detail: "d", pr: "4b" }] })])).toMatchObject({ pass: true, pending: 1, done: 2 });
    expect(summariseRun([r("failed", { failures: [{ beat: 0, kind: "route", detail: "d" }] })])).toMatchObject({ pass: false, failures: 1 });
    expect(summariseRun([r("blocked")])).toMatchObject({ blocked: 1, pass: true });
  });
});
