import type { EventRecord, PendingEvent } from "./events";
import type { ShortlistItem } from "./offer";
import type { CommitPlan } from "./plan";
import type { JevIn, Route } from "./types";

/**
 * What the turn read: Jev's parsed answers (null on a turn that only reacts to a tip or an unlock, which asks Jev
 * nothing about fan text), and the events it reacted to, which is how an unlock is never reacted to twice.
 */
export type JevInRecord = {
  parsed: JevIn | null;
  answers: Record<string, string>;
  events?: EventRecord;
  debounce?: { waitedMs: number; passes: number; foldIns: number };
};

/** A draft that passed every safety check (a quality-only failure still counts), with the batch it answers. */
export interface Candidate {
  draft: string;
  route: Route;
  offerItem: ShortlistItem | null;
  inboundIds: string[];
  /** The tips and unlocks it reacts to. */
  events: PendingEvent[];
  /** Every fan message and event the pass saw, reacted to or not: anything beyond these is new. */
  seenKeys: string[];
  batchText: string;
  jevIn: JevInRecord;
  declineOfferId: string | null;
  attempts: number;
}

export type PassResult =
  | { kind: "idle" }
  /** A hard stop or a hold: nothing to draft. */
  | { kind: "final"; plan: CommitPlan; batchText: string; route: Route }
  /** A drafted reply: `candidate` is null when no attempt passed safety; `lastDraft` is then the draft for the creator to edit. */
  | {
      kind: "draft";
      candidate: Candidate | null;
      lastDraft: string;
      failed: { route: Route; batchText: string; declineOfferId: string | null; record: JevInRecord; events: PendingEvent[] };
    };

/** Tip rows among the events: the commit stamps them with the turn id. */
export const tipRowIds = (events: readonly PendingEvent[]) => events.filter((e) => e.kind === "tip").map((e) => e.id);

/** The synthetic read of a turn with no fan text: nothing to classify, so nothing fires. */
export const NO_FAN_TEXT: JevIn = {
  intent: "smalltalk",
  intentP: 1,
  explicitness: "none",
  p: { minor: 0, self_harm: 0, threat: 0, location_offplatform: 0, payment_dispute: 0, hardship: 0 },
  offerResponse: "na",
  thread: "unknown",
  pitchFitP: null,
  buyIntentP: 0,
  promotedFrom: null,
};
