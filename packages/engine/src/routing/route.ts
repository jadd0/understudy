import type { DeciderResult } from "../ports/decider.js";
import { answerOf } from "../ports/decider.js";
import { canPitch } from "./pacing.js";
import {
  EXPLICITNESS,
  INTENTS,
  SAFETY_KEYS,
  THREADS,
  type Explicitness,
  type Facts,
  type HandoffReason,
  type Intent,
  type JevIn,
  type OfferResponse,
  type Route,
  type RouteCfg,
  type SafetyKey,
  type TemplateKey,
  type ToggleableCheck,
  type ThreadAnswer,
} from "../types.js";
import { DeciderUnavailable } from "../ports/decider.js";

/** The thread answer, or `unknown` when it is missing or outside the options: it never throws, and `unknown` means no thread line, no pitch and no wait. */
export function parseThread(result: DeciderResult): ThreadAnswer {
  const value = result.answers.find((a) => a.key === "thread")?.value;
  return (THREADS as readonly string[]).includes(value ?? "") ? (value as ThreadAnswer) : "unknown";
}

/** Probability that a pitch fits, or null when the question was not asked or its answer is unusable (null means no pitch). */
export function parsePitchFit(result: DeciderResult): number | null {
  const a = result.answers.find((x) => x.key === "pitch_fit");
  if (!a || (a.value !== "yes" && a.value !== "no")) return null;
  const p = a.probabilities.yes ?? (a.value === "yes" ? a.confidence : 1 - a.confidence);
  return Number.isFinite(p) ? p : null;
}

/** Reduces Jev's first-call answers to what routing reads. An intent or explicitness outside the options is malformed; a thread or pitch_fit answer never is. */
export function parseInbound(result: DeciderResult, withOfferResponse: boolean, enabled: Partial<Record<SafetyKey, boolean>> = {}): JevIn {
  const intentAnswer = answerOf(result, "intent");
  if (!(INTENTS as readonly string[]).includes(intentAnswer.value)) throw new DeciderUnavailable("malformed");
  const explicitAnswer = answerOf(result, "explicitness");
  if (!(EXPLICITNESS as readonly string[]).includes(explicitAnswer.value)) throw new DeciderUnavailable("malformed");

  const p = parseSafety(result, enabled);
  const buyP = intentAnswer.probabilities.buy_intent ?? (intentAnswer.value === "buy_intent" ? intentAnswer.confidence : 0);
  return {
    intent: intentAnswer.value as Intent,
    intentP: intentAnswer.probabilities[intentAnswer.value] ?? intentAnswer.confidence,
    explicitness: explicitAnswer.value as Explicitness,
    p,
    offerResponse: withOfferResponse ? (answerOf(result, "offer_response").value as OfferResponse) : "na",
    thread: parseThread(result),
    pitchFitP: parsePitchFit(result),
    buyIntentP: Number.isFinite(buyP) ? buyP : 0,
    promotedFrom: null,
  };
}

/** The ordinary intents a strong runner-up buy can replace; a risk, explicit or human-queue intent never is. */
const PROMOTABLE: readonly Intent[] = ["smalltalk", "flirt"];

/**
 * A fan asking for something new is often read as small talk with `buy_intent` close behind. When the top intent is
 * ordinary and `buy_intent` is at or above `floor.buy_intent_runner_up`, the read becomes `buy_intent` so the offer
 * route applies, with every pacing, cap and hardship rule intact. `intentP` keeps Jev's top probability, so a
 * confident ordinary read is never pushed under `floor.intent` into Juno's queue; `promotedFrom` records the switch.
 */
export function promoteBuyRunnerUp(jev: JevIn, floor: number): JevIn {
  if (!PROMOTABLE.includes(jev.intent) || jev.buyIntentP < floor) return jev;
  return { ...jev, intent: "buy_intent", promotedFrom: jev.intent as "smalltalk" | "flirt" };
}

/** Strictest first, as the safety policy fixes it: the first hard-stop category that fires names the handoff. */
const HARD_STOPS: { key: SafetyKey; reason: HandoffReason; template?: TemplateKey; boundaryLine?: boolean }[] = [
  { key: "minor", reason: "minor", template: "minor_notice" },
  { key: "self_harm", reason: "self_harm", template: "self_harm" },
  { key: "threat", reason: "threat", boundaryLine: true },
  { key: "payment_dispute", reason: "payment_dispute", template: "payment_dispute" },
];

/**
 * The hard stop the safety probabilities call for, or null: the floors applied in the policy's order. A meetup or
 * off-platform ask is not one: it is a boundary strike, decided in `route`.
 */
export function hardStopOf(
  p: Record<SafetyKey, number>,
  floors: RouteCfg["floors"],
  enabled: Partial<Record<SafetyKey, boolean>> = {},
): { reason: HandoffReason; template?: TemplateKey; boundaryLine?: boolean } | null {
  const fired = (key: SafetyKey) => enabled[key] !== false && p[key] >= floors[key];
  const stop = HARD_STOPS.find((h) => fired(h.key));
  if (!stop) return null;
  const template = fired("self_harm") ? "self_harm" : stop.template;
  // A fired self-harm check sends the crisis template, never a model-written line.
  return { reason: stop.reason, template, boundaryLine: stop.boundaryLine && template === undefined ? true : undefined };
}

/** Reads the six safety answers (probability of "yes") out of a Jev result; a disabled check was not asked and reads 0. */
export function parseSafety(result: DeciderResult, enabled: Partial<Record<SafetyKey, boolean>> = {}): Record<SafetyKey, number> {
  const p = {} as Record<SafetyKey, number>;
  for (const key of SAFETY_KEYS) {
    if (enabled[key] === false) {
      p[key] = 0;
      continue;
    }
    const a = answerOf(result, key);
    p[key] = a.probabilities.yes ?? (a.value === "yes" ? a.confidence : 1 - a.confidence);
  }
  return p;
}

/**
 * The routing matrix as code. Trusted facts and Jev's classification in, one route out. Order is the policy:
 * Trust & Safety categories (trigger at p >= floor), then Juno's queue, then the AI's own routes. A fired
 * self-harm check always sends the crisis template, even when a more severe reason names the handoff.
 */
export function route(jev: JevIn, facts: Facts, cfg: RouteCfg): Route {
  const fired = (key: SafetyKey) => cfg.enabled[key as ToggleableCheck] !== false && jev.p[key] >= cfg.floors[key];
  const hardship = fired("hardship");
  const alert = facts.highValue && !facts.hasUnresolvedHandoff;

  // A chat the sweep just settled by policy is answered instead of held again: the fan repeating the request
  // would otherwise queue the same wait.
  const hold = (reason: HandoffReason): Route =>
    facts.holdSuppressed ? { name: "deflect", hardship, alert } : { name: "hold_creator", reason, hardship, alert };

  const stop = hardStopOf(jev.p, cfg.floors, cfg.enabled);
  if (stop) return { name: "hard_stop", reason: stop.reason, template: stop.template, boundaryLine: stop.boundaryLine, hardship: false, alert: false };

  // A meetup or off-platform ask is a strike: her boundary line and a numbered warning while the AI keeps chatting,
  // and the strike that reaches the maximum pauses the chat for Trust & Safety. Minors and self-harm were decided above.
  // A confident buy ask is the one read Jev scores off-platform on money talk alone, so it is not struck unless the
  // off-platform read is itself confident; every such turn still drafts through verify's off-platform check.
  const buyAsk =
    jev.intent === "buy_intent" &&
    jev.promotedFrom === null &&
    jev.intentP >= cfg.floors.intent &&
    jev.p.location_offplatform < cfg.floors.offplatformOnBuy;
  if (fired("location_offplatform") && !buyAsk) {
    return facts.strikesSoFar + 1 >= cfg.maxStrikes
      ? { name: "hard_stop", reason: "location_offplatform", strike: true, hardship: false, alert: false }
      : { name: "boundary", strike: true, hardship: false, alert: false };
  }

  if (jev.intentP < cfg.floors.intent) {
    // An unsure read whose best guess is buying still gets a code-picked offer when pacing allows: a wrong
    // offer costs the fan one decline, a wrong hold costs Juno's time and the sale.
    // Like any buy intent it skips the fit check, and the AI still never offers the personal chat.
    if (jev.intent === "buy_intent" && !hardship && canPitch(facts, cfg, jev.intent).ok) {
      return { name: "offer", offerKinds: ["ppv", "bundle"], fallback: "reply", hardship, alert };
    }
    return hold("unsure");
  }
  if (jev.intent === "live_chat") return hold("explicit_live_chat");
  if (jev.intent === "custom_request") return hold("custom_request");

  if (jev.intent === "ai_question") return { name: "ai_disclosure", hardship, alert };
  if (jev.intent === "manipulation") return { name: "deflect", hardship, alert };

  // canPitch lets a buy_intent or an explicit_request skip the round gap; the other limits still apply.
  const pitch = canPitch(facts, cfg, jev.intent).ok && !hardship;

  // What the fan asked for is offered without a fit check; the AI never offers the personal chat (it goes to Juno).
  if (jev.intent === "explicit_request" || jev.explicitness === "explicit") {
    return pitch
      ? { name: "offer", offerKinds: ["ppv"], fallback: "deflect", hardship, alert }
      : { name: "deflect", hardship, alert };
  }
  if (jev.intent === "buy_intent") {
    return pitch
      ? { name: "offer", offerKinds: ["ppv", "bundle"], fallback: "reply", hardship, alert }
      : { name: "reply", hardship, alert };
  }
  // An AI-initiated pitch also needs a flowing chat and a fit: no open offer, not a fresh session, he is on her thread.
  const fits =
    !facts.hasOpenOffer &&
    !facts.sessionStart &&
    (jev.thread === "answers_her" || jev.thread === "same_topic") &&
    jev.pitchFitP !== null &&
    jev.pitchFitP >= cfg.fitFloor;
  return pitch && fits
    ? { name: "offer", offerKinds: ["ppv", "bundle"], fallback: "reply", hardship, alert }
    : { name: "reply", hardship, alert };
}
