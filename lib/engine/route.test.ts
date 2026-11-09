import { describe, expect, test } from "vitest";
import type { DeciderResult } from "@/platform/ports/decider";
import { parseInbound, promoteBuyRunnerUp, route } from "@/lib/engine/route";
import { INTENTS } from "@/lib/engine/types";
import { THREADS } from "@/lib/engine/types";
import { CFG, facts, jev, PITCHABLE } from "./test-fixtures";

const r = (j = jev(), f = facts()) => route(j, f, CFG);

describe("route: the  matrix", () => {
  test("small talk, flirting and plain questions are answered by the AI", () => {
    expect(r(jev({ intent: "smalltalk" }))).toMatchObject({ name: "reply", hardship: false, alert: false });
    expect(r(jev({ intent: "flirt", explicitness: "flirty" })).name).toBe("reply");
    expect(r(jev({ intent: "flirt", explicitness: "suggestive" })).name).toBe("reply");
  });

  test("buying intent becomes an offer when pacing allows, otherwise a reply", () => {
    expect(r(jev({ intent: "buy_intent" }), facts(PITCHABLE)).name).toBe("offer");
    expect(r(jev({ intent: "buy_intent" }), facts({ atCap: true })).name).toBe("reply");
  });

  test("an explicit request is offered a locked ppv item, or deflected when pacing refuses", () => {
    const allowed = r(jev({ intent: "explicit_request", explicitness: "explicit" }), facts(PITCHABLE));
    expect(allowed).toMatchObject({ name: "offer", offerKinds: ["ppv"] });
    expect(r(jev({ intent: "explicit_request", explicitness: "explicit" }), facts({ ...PITCHABLE, atCap: true })).name).toBe("deflect");
    // an early explicit request (short gap) still gets the paid offer; the other limits still deflect it
    const early = facts({ roundsSinceOffer: 1 });
    expect(r(jev({ intent: "explicit_request", explicitness: "explicit" }), early)).toMatchObject({ name: "offer", offerKinds: ["ppv"] });
    for (const block of [{ atCap: true }, { declinesInWindow: 2 }, { unlocksInWindow: 3 }, { noPitchActive: true }]) {
      expect(r(jev({ intent: "explicit_request", explicitness: "explicit" }), facts({ ...early, ...block })).name).toBe("deflect");
    }
    // explicit text under another intent still never gets a normal reply
    expect(r(jev({ intent: "flirt", explicitness: "explicit" })).name).toBe("deflect");
  });

  test("a sincere AI question is a disclosure", () => {
    expect(r(jev({ intent: "ai_question" })).name).toBe("ai_disclosure");
  });

  test("rudeness, manipulation and injection are deflected", () => {
    expect(r(jev({ intent: "manipulation" })).name).toBe("deflect");
  });

  test("live explicit chat and custom requests go to Juno", () => {
    expect(r(jev({ intent: "live_chat" }))).toMatchObject({ name: "hold_creator", reason: "explicit_live_chat" });
    expect(r(jev({ intent: "custom_request" }))).toMatchObject({ name: "hold_creator", reason: "custom_request" });
  });

  test("a high-value fan keeps getting AI replies and raises an alert, unless a handoff is already open", () => {
    expect(r(jev(), facts({ highValue: true }))).toMatchObject({ name: "reply", alert: true });
    expect(r(jev(), facts({ highValue: true, hasUnresolvedHandoff: true })).alert).toBe(false);
  });

  test.each([
    ["minor", "minor", "minor_notice"],
    ["self_harm", "self_harm", "self_harm"],
    ["threat", "threat", undefined],
    ["location_offplatform", "location_offplatform", "location_offplatform"],
    ["payment_dispute", "payment_dispute", "payment_dispute"],
  ] as const)("%s is a hard stop to Trust & Safety", (key, reason, template) => {
    const out = r(jev({ p: { [key]: 0.9 } }));
    expect(out).toMatchObject({ name: "hard_stop", reason });
    expect(out.template).toBe(template);
  });

  test("hardship is supportive: a reply with no offer, even for buying intent", () => {
    const out = r(jev({ intent: "buy_intent", p: { hardship: 0.8 } }), facts(PITCHABLE));
    expect(out).toMatchObject({ name: "reply", hardship: true });
  });

  test("low intent confidence goes to Juno as unsure", () => {
    expect(r(jev({ intentP: 0.4 }))).toMatchObject({ name: "hold_creator", reason: "unsure" });
  });

  test("an unsure read that is most likely buying is offered, not held, when pacing allows", () => {
    // live case: "is there an offer you can give me so i can play with u?" read as buy_intent at 0.46
    expect(r(jev({ intent: "buy_intent", intentP: 0.46 }), facts(PITCHABLE)).name).toBe("offer");
    expect(r(jev({ intent: "buy_intent", intentP: 0.46 }), facts({ ...PITCHABLE, atCap: true }))).toMatchObject({ name: "hold_creator", reason: "unsure" });
    expect(r(jev({ intent: "buy_intent", intentP: 0.46, p: { hardship: 0.8 } }), facts(PITCHABLE))).toMatchObject({ name: "hold_creator", reason: "unsure" });
    expect(r(jev({ intent: "custom_request", intentP: 0.46 }), facts(PITCHABLE))).toMatchObject({ name: "hold_creator", reason: "unsure" });
  });
});

describe("route: precedence and floors", () => {
  test("minor outranks high value", () => {
    const out = r(jev({ intent: "buy_intent", p: { minor: 0.9 } }), facts({ ...PITCHABLE, highValue: true }));
    expect(out).toMatchObject({ name: "hard_stop", reason: "minor", alert: false });
  });

  test("a trigger fires at p >= floor, not above it", () => {
    expect(r(jev({ p: { minor: 0.3 } })).name).toBe("hard_stop");
    expect(r(jev({ p: { minor: 0.29 } })).name).toBe("reply");
    expect(r(jev({ p: { minor: 0.05 } })).name).toBe("reply");
  });

  test("safety outranks the intent floor, and the intent floor is the only confidence floor", () => {
    expect(r(jev({ intentP: 0.1, p: { threat: 0.7 } }))).toMatchObject({ name: "hard_stop", reason: "threat" });
    expect(r(jev({ intentP: 0.5 })).name).toBe("reply");
  });

  test("the strictest hard stop names the handoff, and self-harm still sends its crisis reply", () => {
    const out = r(jev({ p: { minor: 0.9, self_harm: 0.9, payment_dispute: 0.9 } }));
    expect(out).toMatchObject({ name: "hard_stop", reason: "minor", template: "self_harm" });
  });

  test("Juno's queue outranks the AI routes", () => {
    expect(r(jev({ intent: "live_chat", p: { hardship: 0.9 } })).name).toBe("hold_creator");
  });

  test("a sincere AI question is answered even when the fan is in hardship, and the cooldown still starts", () => {
    expect(r(jev({ intent: "ai_question", p: { hardship: 0.9 } }))).toMatchObject({ name: "ai_disclosure", hardship: true });
  });

  test("an AI-initiated pitch happens on small talk when pacing allows it", () => {
    expect(r(jev({ intent: "smalltalk" }), facts(PITCHABLE)).name).toBe("offer");
  });
});

describe("route: an AI-initiated pitch must fit the chat", () => {
  const pitchy = (over: Parameters<typeof jev>[0] = {}, f: Parameters<typeof facts>[0] = {}) => r(jev({ intent: "smalltalk", ...over }), facts({ ...PITCHABLE, ...f }));

  test.each([...THREADS, "unknown"] as const)("ai_pitch_needs_fit_and_flowing_thread: thread %s", (thread) => {
    const flowing = thread === "answers_her" || thread === "same_topic";
    expect(pitchy({ thread }).name).toBe(flowing ? "offer" : "reply");
    // a flowing thread alone is not enough: the fit has to clear the floor
    expect(pitchy({ thread, pitchFitP: 0.59 }).name).toBe("reply");
    expect(pitchy({ thread, pitchFitP: 0.6 }).name).toBe(flowing ? "offer" : "reply");
  });

  test("no_ai_pitch_on_session_start", () => {
    expect(pitchy({}, { sessionStart: true }).name).toBe("reply");
    expect(pitchy({ intent: "flirt", explicitness: "flirty" }, { sessionStart: true }).name).toBe("reply");
  });

  test("no_ai_pitch_while_offer_open_but_buy_intent_still_offers", () => {
    expect(pitchy({}, { hasOpenOffer: true }).name).toBe("reply");
    expect(pitchy({ intent: "buy_intent", thread: "new_topic", pitchFitP: null }, { hasOpenOffer: true })).toMatchObject({ name: "offer", offerKinds: ["ppv", "bundle"] });
  });

  test("ai_pitch_kinds_ppv_bundle", () => {
    expect(pitchy()).toMatchObject({ name: "offer", offerKinds: ["ppv", "bundle"], fallback: "reply" });
    expect(pitchy({ intent: "flirt", explicitness: "flirty" })).toMatchObject({ offerKinds: ["ppv", "bundle"] });
    expect(pitchy({ intent: "buy_intent" }).offerKinds).toEqual(["ppv", "bundle"]);
  });

  test("malformed_thread_is_unknown_and_blocks_pitch", () => {
    const answer = (key: string, value: string) => ({ key, value, confidence: 0.9, probabilities: { [value]: 0.9 } });
    const calm = ["minor", "self_harm", "threat", "location_offplatform", "payment_dispute", "hardship"].map((k) => answer(k, "no"));
    const result = (extra: DeciderResult["answers"]): DeciderResult => ({
      answers: [answer("intent", "smalltalk"), answer("explicitness", "none"), ...calm, ...extra],
      model: "m",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(parseInbound(result([answer("thread", "banana"), answer("pitch_fit", "yes")]), false).thread).toBe("unknown");
    expect(parseInbound(result([answer("pitch_fit", "yes")]), false).thread).toBe("unknown");
    expect(parseInbound(result([answer("thread", "returning")]), false).thread).toBe("returning");
    const bad = parseInbound(result([answer("thread", "banana"), answer("pitch_fit", "yes")]), false);
    expect(route(bad, facts(PITCHABLE), CFG).name).toBe("reply");
  });

  test("missing_pitch_fit_blocks_pitch", () => {
    const answer = (key: string, value: string) => ({ key, value, confidence: 0.9, probabilities: { [value]: 0.9 } });
    const calm = ["minor", "self_harm", "threat", "location_offplatform", "payment_dispute", "hardship"].map((k) => answer(k, "no"));
    const base = [answer("intent", "smalltalk"), answer("explicitness", "none"), ...calm, answer("thread", "same_topic")];
    const res = (extra: DeciderResult["answers"]): DeciderResult => ({ answers: [...base, ...extra], model: "m", usage: { inputTokens: 1, outputTokens: 1 } });
    const missing = parseInbound(res([]), false);
    expect(missing.pitchFitP).toBeNull();
    expect(route(missing, facts(PITCHABLE), CFG).name).toBe("reply");
    expect(parseInbound(res([answer("pitch_fit", "maybe")]), false).pitchFitP).toBeNull();
    const no = parseInbound(res([{ key: "pitch_fit", value: "no", confidence: 0.8, probabilities: { yes: 0.2, no: 0.8 } }]), false);
    expect(no.pitchFitP).toBeCloseTo(0.2);
    expect(route(no, facts(PITCHABLE), CFG).name).toBe("reply");
  });

  test("an unsure buy intent skips the fit check and offers only ppv or bundle", () => {
    const out = r(jev({ intent: "buy_intent", intentP: 0.46, thread: "new_topic", pitchFitP: null }), facts(PITCHABLE));
    expect(out).toMatchObject({ name: "offer", offerKinds: ["ppv", "bundle"], fallback: "reply" });
  });

  test("explicit_buy_skips_fit: what he asked for is offered without a fit answer", () => {
    expect(pitchy({ intent: "buy_intent", thread: "unknown", pitchFitP: null })).toMatchObject({ name: "offer" });
    expect(pitchy({ intent: "explicit_request", explicitness: "explicit", thread: "returning", pitchFitP: null })).toMatchObject({
      name: "offer",
      offerKinds: ["ppv"],
      fallback: "deflect",
    });
  });

  test("fallback is reply for a pitch and deflect for explicit, so a failed pick never turns a pitch into a deflect", () => {
    expect(pitchy().fallback).toBe("reply");
    expect(pitchy({ intent: "explicit_request", explicitness: "explicit" }).fallback).toBe("deflect");
  });
});

describe("a strong runner-up buy_intent is routed as a buy", () => {
  const calm = ["minor", "self_harm", "threat", "location_offplatform", "payment_dispute", "hardship"].map((key) => ({
    key,
    value: "no",
    confidence: 0.98,
    probabilities: { yes: 0.02, no: 0.98 },
  }));
  const inbound = (top: string, probabilities: Record<string, number>): DeciderResult => ({
    answers: [
      { key: "intent", value: top, confidence: probabilities[top], probabilities },
      { key: "explicitness", value: "none", confidence: 0.9, probabilities: { none: 0.9 } },
      ...calm,
      { key: "thread", value: "new_topic", confidence: 0.9, probabilities: { new_topic: 0.9 } },
    ],
    model: "m",
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  const read = (top: string, probabilities: Record<string, number>) =>
    promoteBuyRunnerUp(parseInbound(inbound(top, probabilities), false), CFG.floors.buyIntentRunnerUp);

  test("parseInbound keeps buy_intent's probability whichever intent won", () => {
    expect(parseInbound(inbound("smalltalk", { smalltalk: 0.56, buy_intent: 0.35 }), false)).toMatchObject({ intent: "smalltalk", buyIntentP: 0.35, promotedFrom: null });
    expect(parseInbound(inbound("smalltalk", { smalltalk: 0.9 }), false).buyIntentP).toBe(0);
    expect(parseInbound(inbound("buy_intent", { buy_intent: 0.77 }), false).buyIntentP).toBe(0.77);
  });

  test("smalltalk or flirt with buy_intent at or above the floor becomes buy_intent and offers", () => {
    // live case: "got anything new you've been working on this week? id love to see it" read smalltalk first
    const promoted = read("smalltalk", { smalltalk: 0.56, buy_intent: 0.35 });
    expect(promoted).toMatchObject({ intent: "buy_intent", intentP: 0.56, buyIntentP: 0.35, promotedFrom: "smalltalk" });
    // thread new_topic and no pitch_fit: as smalltalk this could never be an AI-started pitch
    expect(route(promoted, facts(), CFG)).toMatchObject({ name: "offer", offerKinds: ["ppv", "bundle"], fallback: "reply" });
    expect(read("flirt", { flirt: 0.6, buy_intent: 0.3 })).toMatchObject({ intent: "buy_intent", promotedFrom: "flirt" });
  });

  test("below the floor nothing changes", () => {
    const kept = read("smalltalk", { smalltalk: 0.7, buy_intent: 0.29 });
    expect(kept).toMatchObject({ intent: "smalltalk", promotedFrom: null });
    expect(route(kept, facts(), CFG).name).toBe("reply");
  });

  test("a risk, explicit or human-queue intent is never promoted, however likely the buy", () => {
    for (const top of INTENTS.filter((i) => i !== "smalltalk" && i !== "flirt" && i !== "buy_intent")) {
      const out = read(top, { [top]: 0.5, buy_intent: 0.45 });
      expect(out, top).toMatchObject({ intent: top, promotedFrom: null });
    }
  });

  test("a promoted buy keeps every pacing, hardship, explicit and hard-stop rule", () => {
    const buy = jev({ intent: "smalltalk", buyIntentP: 0.4 });
    const promoted = promoteBuyRunnerUp(buy, CFG.floors.buyIntentRunnerUp);
    expect(route(promoted, facts({ atCap: true }), CFG).name).toBe("reply");
    expect(route(promoteBuyRunnerUp(jev({ ...buy, p: { hardship: 0.8 } }), 0.3), facts(PITCHABLE), CFG)).toMatchObject({ name: "reply", hardship: true });
    expect(route(promoteBuyRunnerUp(jev({ ...buy, p: { minor: 0.9 } }), 0.3), facts(PITCHABLE), CFG)).toMatchObject({ name: "hard_stop", reason: "minor" });
    // explicit text under flirt is still the ppv-or-deflect route, not a bundle
    const explicit = promoteBuyRunnerUp(jev({ intent: "flirt", explicitness: "explicit", buyIntentP: 0.9 }), 0.3);
    expect(route(explicit, facts(), CFG)).toMatchObject({ name: "offer", offerKinds: ["ppv"], fallback: "deflect" });
  });

  test("an unsure ordinary read with a strong buy takes the unsure-buy branch", () => {
    const unsure = promoteBuyRunnerUp(jev({ intent: "smalltalk", intentP: 0.45, buyIntentP: 0.4 }), 0.3);
    expect(route(unsure, facts(), CFG).name).toBe("offer");
    expect(route(unsure, facts({ atCap: true }), CFG)).toMatchObject({ name: "hold_creator", reason: "unsure" });
  });
});
