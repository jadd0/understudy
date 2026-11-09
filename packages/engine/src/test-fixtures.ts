import type { Facts, JevIn, RouteCfg } from "./types";

export const CFG: RouteCfg = {
  floors: {
    minor: 0.3,
    self_harm: 0.3,
    threat: 0.5,
    location_offplatform: 0.5,
    payment_dispute: 0.6,
    hardship: 0.5,
    intent: 0.5,
    buyIntentRunnerUp: 0.3,
  },
  minGapRounds: 8,
  fitFloor: 0.6,
  maxDeclines: 2,
  velocityMaxUnlocks: 3,
};

export const CALM = {
  minor: 0.02,
  self_harm: 0.02,
  threat: 0.02,
  location_offplatform: 0.02,
  payment_dispute: 0.02,
  hardship: 0.02,
};

export function jev(over: Partial<Omit<JevIn, "p">> & { p?: Partial<JevIn["p"]> } = {}): JevIn {
  const { p, ...rest } = over;
  return { intent: "smalltalk", intentP: 0.9, explicitness: "none", offerResponse: "na", thread: "same_topic", pitchFitP: 0.9, buyIntentP: 0, promotedFrom: null, ...rest, p: { ...CALM, ...p } };
}

/** Baseline: a pitch is not allowed (the gap is short), no alert. */
export function facts(over: Partial<Facts> = {}): Facts {
  return {
    noPitchActive: false,
    declinesInWindow: 0,
    atCap: false,
    spentTodayCents: 0,
    capCents: 20000,
    unlocksInWindow: 0,
    roundsSinceOffer: 2,
    highValue: false,
    hasUnresolvedHandoff: false,
    hasOpenOffer: false,
    hasUnlocked: false,
    justUnlocked: false,
    sessionStart: false,
    ...over,
  };
}

export const PITCHABLE = { roundsSinceOffer: 20 };
