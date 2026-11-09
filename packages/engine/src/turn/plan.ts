import type { HandoffSla } from "../conversation/handoff";
import type { HandoffQueue, HandoffReason, RouteName } from "../types";

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
