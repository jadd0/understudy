import type { handoffReasonEnum, turnRouteEnum } from "@/db/schema";

export type HandoffReason = (typeof handoffReasonEnum.enumValues)[number];
export type RouteName = (typeof turnRouteEnum.enumValues)[number];
export type HandoffQueue = "creator" | "ts";

export const INTENTS = [
  "smalltalk",
  "flirt",
  "buy_intent",
  "explicit_request",
  "ai_question",
  "manipulation",
  "live_chat",
  "custom_request",
] as const;
export type Intent = (typeof INTENTS)[number];

export const EXPLICITNESS = ["none", "flirty", "suggestive", "explicit"] as const;
export type Explicitness = (typeof EXPLICITNESS)[number];

export const SAFETY_KEYS = ["minor", "self_harm", "threat", "location_offplatform", "payment_dispute", "hardship"] as const;
export type SafetyKey = (typeof SAFETY_KEYS)[number];

export const THREADS = ["answers_her", "same_topic", "new_topic", "returning", "still_typing"] as const;
/** How the fan's new messages fit the chat so far; `unknown` when Jev's answer is missing or outside the options. */
export type ThreadAnswer = (typeof THREADS)[number] | "unknown";

export type OfferResponse = "accepts" | "declines" | "ignores" | "na";

/** Jev's first-call output reduced to what routing reads. Probabilities are of the "yes" option. */
export interface JevIn {
  intent: Intent;
  /** Probability Jev gave the intent it chose. */
  intentP: number;
  explicitness: Explicitness;
  p: Record<SafetyKey, number>;
  offerResponse: OfferResponse;
  thread: ThreadAnswer;
  /** Probability that a pitch fits the chat now, or null when it was not asked or the answer was unusable (no pitch). */
  pitchFitP: number | null;
  /** Probability Jev gave `buy_intent`, whichever intent it chose (0 when it gave none). */
  buyIntentP: number;
  /** The ordinary intent Jev chose when a strong runner-up `buy_intent` replaced it, else null. */
  promotedFrom: "smalltalk" | "flirt" | null;
}

export interface RouteCfg {
  floors: Record<SafetyKey, number> & { intent: number; buyIntentRunnerUp: number };
  minGapRounds: number;
  /** An AI-initiated pitch needs `pitch_fit` at or above this. */
  fitFloor: number;
  maxDeclines: number;
  velocityMaxUnlocks: number;
}

/** Everything pacing and routing read about the fan, computed against the database clock before the route is decided. */
export interface PitchFacts {
  /** `conversations.no_pitch_until` is still in the future. */
  noPitchActive: boolean;
  /** Offers declined inside the cooldown window. */
  declinesInWindow: number;
  /** Nothing more fits under the fan's effective daily cap today (`capAllows` refuses even one cent). */
  atCap: boolean;
  /** Unlocks inside the velocity window. */
  unlocksInWindow: number;
  /** Rounds (a fan batch plus a turn that answered it) since the last offer, or in total when there has been none. */
  roundsSinceOffer: number;
}

export interface Facts extends PitchFacts {
  /** Cents spent since 00:00 UTC today, and the cap in force: an item is pitched only if `capAllows` its price. */
  spentTodayCents: number;
  capCents: number;
  highValue: boolean;
  hasUnresolvedHandoff: boolean;
  hasOpenOffer: boolean;
  /** He has unlocked something from this creator before: online plans like a game are then allowed. */
  hasUnlocked: boolean;
  /** He accepted an offer after her last message: an unlock leaves no chat line, so Jev is told. */
  justUnlocked: boolean;
  /** Her silence before this batch is at least `engine.gap_marker_minutes`: the fan is starting a new session. */
  sessionStart: boolean;
}

export type TemplateKey = "self_harm" | "payment_dispute" | "location_offplatform" | "minor_notice";

export interface Route {
  name: RouteName;
  /** hard_stop and hold_creator: why a human owns the conversation now. */
  reason?: HandoffReason;
  /** hard_stop: the fixed reply to send before stopping, if any. */
  template?: TemplateKey;
  /** offer: only these catalogue kinds may be offered. */
  offerKinds?: ("ppv" | "bundle" | "personal")[];
  /** Where the turn falls back to when an offer cannot be built: deflect for explicit, reply for everything else. */
  fallback?: "reply" | "deflect";
  /** The fan showed financial hardship or distress: supportive, no pitch, and the cooldown starts. */
  hardship: boolean;
  /** Open a high_value_alert for the creator (the AI keeps replying). */
  alert: boolean;
}
