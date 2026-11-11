import { eventRecord, type PendingEvent } from "../conversation/events.js";
import type { EngineCfg } from "../config/load.js";
import { route as decideRoute } from "../routing/route.js";
import { template, templateSender } from "../drafting/templates.js";
import type { Facts, JevIn, Route } from "../types.js";
import { draftFiller } from "./filler.js";
import { tipRowIds, type JevInRecord, type PassResult } from "./pass.js";
import { basePlan } from "./plan.js";
import type { Batch, Classified, TurnState } from "./state.js";

export interface Routed {
  route: Route;
  /** The events the reply reacts to; empty for a fan in hardship. */
  reacting: PendingEvent[];
  declineOfferId: string | null;
  record: JevInRecord;
}

/** The route for a read, with the adjustments the chat's state calls for. Pure: it changes nothing. */
export function adjustRoute(
  jevIn: JevIn,
  facts: Facts,
  routeCfg: EngineCfg["route"],
  opts: { eventOnly: boolean; openOffer: string | null; reacting: PendingEvent[] },
): { route: Route; reacting: PendingEvent[]; declineOfferId: string | null } {
  const declineOfferId = jevIn.offerResponse === "declines" ? opts.openOffer : null;
  // A decline in this very message counts toward the pitch limit now, not on the next turn.
  const routingFacts: Facts = declineOfferId ? { ...facts, declinesInWindow: facts.declinesInWindow + 1 } : facts;
  let route: Route = opts.eventOnly ? { name: "reply", hardship: false, alert: false } : decideRoute(jevIn, routingFacts, routeCfg);
  // A fan in hardship is not thanked for spending; the events stay unstamped and age out.
  const reacting = route.hardship ? [] : opts.reacting;
  // Thanks or a check-in never carries a new offer: an offer route answers in words alone this turn.
  if (reacting.length > 0 && route.name === "offer") route = { ...route, name: route.fallback ?? "reply" };
  return { route, reacting, declineOfferId };
}

/** Chooses the route for a classified batch and records it, with what Jev read, on the accumulator. */
export function chooseRoute(s: TurnState, b: Batch, c: Classified): Routed {
  const { route, reacting, declineOfferId } = adjustRoute(c.jevIn, b.facts, s.cfg.route, { eventOnly: b.eventOnly, openOffer: b.openOffer, reacting: b.reacting });
  s.acc.route = route.name;
  const record: JevInRecord = { parsed: b.eventOnly ? null : c.jevIn, answers: c.jevAnswers, events: eventRecord(reacting) };
  s.acc.jevIn = record;
  return { route, reacting, declineOfferId, record };
}

/** A hard stop or a hold: no reply is drafted, so the pass ends with its plan (a filler or a boundary line apart). */
export async function stopPass(s: TurnState, b: Batch, c: Classified, r: Routed): Promise<PassResult> {
  const { route } = r;
  const { cfg } = s;
  const plan = basePlan(s, route, r.declineOfferId, r.record);
  // A human owns the chat now and sees the tip row; it is not left queued for a later AI thanks.
  plan.eventMessageIds = tipRowIds(r.reacting);
  if (route.name === "hard_stop" && route.strike) {
    // The strike that pauses the chat: the commit moves it to Trust & Safety and sends the paused notice, only if
    // the chat is still the AI's. A takeover that got there first wins and no strike is recorded.
    plan.outcome = "hard_stop";
  } else if (route.name === "hard_stop") {
    plan.outcome = "hard_stop";
    plan.setMode = "handoff_ts";
    plan.handoff = { queue: "ts", reason: route.reason! };
    plan.hardStop = { reason: route.reason!, flagUser: route.reason === "minor" || route.reason === "threat" };
    if (route.template) {
      plan.reply = { body: template(route.template, cfg.supportEmail), kind: "sent", sender: templateSender(route.template) };
    } else if (route.boundaryLine) {
      // One line in her voice before the flag. No passing line keeps the silent stop.
      const line = await draftFiller(s, b, route, c.jevIn.thread, true);
      if (line) plan.reply = { body: line, kind: "sent" };
    }
  } else {
    plan.outcome = "handoff";
    plan.setMode = "handoff_creator";
    plan.handoff = { queue: "creator", reason: route.reason! };
    const filler = await draftFiller(s, b, route, c.jevIn.thread, false);
    if (filler) plan.reply = { body: filler, kind: "sent" };
  }
  return { kind: "final", plan, batchText: b.batchText, route };
}
