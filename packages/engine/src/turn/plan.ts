import type { HandoffSla } from "../conversation/handoff.js";
import { bubbleGap } from "../drafting/bubbles.js";
import type { HandoffQueue, HandoffReason, Route, RouteName } from "../types.js";
import { template } from "../drafting/templates.js";
import { tipRowIds, type JevInRecord, type PassResult } from "./pass.js";
import type { TurnState } from "./state.js";

export interface TurnRecord {
  inboundIds: string[];
  route: RouteName | null;
  jevIn: unknown;
  jevOut: unknown;
  draft: string | null;
  personaVersion: number | null;
  models: unknown;
  tokens: unknown;
  costMicros: number;
  msJevIn: number | null;
  msGen: number | null;
  msJevOut: number | null;
  attempts: number | null;
}

export interface CommitPlan {
  /** Outcome recorded when the reply part applies: replied | handoff | hard_stop | suggested. */
  outcome: string;
  turn: TurnRecord;
  /** What to say. A `draft` is held for the creator (never shown to the fan); anything else is sent. */
  reply: { body: string; kind: "sent" | "draft"; sender?: "ai" | "system"; fixed?: boolean } | null;
  offer: { itemId: string; priceCents: number; ttlMinutes: number } | null;
  /** An offer the fan just declined. */
  declineOfferId: string | null;
  /** Handoff this turn opens or escalates, and the mode the conversation moves to with it. */
  handoff: { queue: HandoffQueue; reason: HandoffReason } | null;
  setMode: "handoff_creator" | "handoff_ts" | null;
  /** hard_stop: this is the safety outcome, applied whatever happened to the conversation during the turn. */
  hardStop: { reason: HandoffReason; flagUser: boolean } | null;
  /**
   * A boundary strike (a meetup or off-platform ask). The commit counts it under the conversation lock, writes the
   * strike row, adds the platform notice after any reply, and opens a Trust & Safety alert that leaves the mode
   * alone; when the strike reaches `maxStrikes` it moves the conversation to `handoff_ts` instead. It is part of the
   * compare-and-set: a takeover that won leaves no strike, notice or hand-off behind.
   */
  strike?: { reason: HandoffReason; maxStrikes: number; windowDays: number } | null;
  /** Open a high_value_alert for the creator; the AI keeps replying. */
  alert: boolean;
  hardshipCooldownHours: number | null;
  /** How long a handoff this turn opens may wait before its due time. */
  sla: HandoffSla;
  /** Tip rows this turn reacted to: stamped with its turn id like the inbound, but kept out of `inbound_ids`, which counts fan messages. */
  eventMessageIds?: string[];
  typing: { cps: number; maxMs: number; gapMs: number };
}

export type CommitResult =
  | { applied: true; turnId: string; messageIds: string[]; offerId: string | null; handoffId: string | null; deliverInMs: number[] }
  /** A lost compare-and-set still delivers a hard stop's template (`messageIds`); a plain draft is stored unsent. */
  | { applied: false; turnId: string; handoffId: string | null; messageIds: string[]; deliverInMs: number[] };

/**
 * The plan every outcome starts from: the route and what Jev read go onto the accumulator, and the commit's fixed
 * settings (strike limits, SLA, typing pace) are read from the config. The caller fills in what it does.
 */
export function basePlan(s: TurnState, route: Route, declineOfferId: string | null, jevIn: JevInRecord): CommitPlan {
  const { cfg, acc, stats } = s;
  acc.jevIn = { ...jevIn, debounce: { waitedMs: stats.waitedMs, passes: stats.passes, foldIns: s.foldIns } };
  acc.route = route.name;
  return {
    outcome: "replied",
    turn: acc,
    reply: null,
    offer: null,
    declineOfferId,
    handoff: null,
    setMode: null,
    hardStop: null,
    // A strike is counted by the commit itself, under the conversation lock, so a draft retry never records one.
    strike: route.strike ? { reason: "location_offplatform", maxStrikes: cfg.route.maxStrikes, windowDays: cfg.strikeWindowDays } : null,
    alert: route.alert,
    sla: cfg.sla,
    hardshipCooldownHours: route.hardship ? cfg.hardshipCooldownHours : null,
    typing: {
      cps: cfg.typingCps,
      maxMs: cfg.typingMaxMs,
      gapMs: bubbleGap(cfg.bubbleGapMsMin, cfg.bubbleGapMsMax, s.ctx.deps.random ?? Math.random),
    },
  };
}

/**
 * The plan for a pass where no draft passed safety. A boundary line sends the fixed line with the same warning and the
 * AI keeps chatting; anything else holds the last draft for the creator to edit and hands the conversation over.
 */
export function unsafePlan(s: TurnState, failed: Extract<PassResult, { kind: "draft" }>["failed"], lastDraft: string): CommitPlan {
  const plan = basePlan(s, failed.route, failed.declineOfferId, failed.record);
  if (failed.route.name === "boundary") {
    plan.reply = { body: template("location_offplatform", s.cfg.supportEmail), kind: "sent", fixed: true };
    return plan;
  }
  plan.outcome = "suggested";
  // A blank draft (a refused generation) is no suggestion: she gets the handoff alone.
  plan.reply = lastDraft.trim() === "" ? null : { body: lastDraft, kind: "draft" };
  plan.setMode = "handoff_creator";
  plan.handoff = { queue: "creator", reason: "verify_failed" };
  plan.eventMessageIds = tipRowIds(failed.events);
  return plan;
}
