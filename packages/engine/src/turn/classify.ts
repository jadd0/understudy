import { disabledChecks, inboundQuestions } from "../routing/questions";
import { parseInbound, promoteBuyRunnerUp } from "../routing/route";
import type { JevIn } from "../types";
import type { Batch, Classified, TurnState } from "./state";

/** Asks Jev the inbound questions about the new messages and parses the answers. */
export async function classifyInbound(s: TurnState, b: Batch, askFit: boolean): Promise<Classified> {
  const { cfg } = s;
  const clock = s.ctx.deps.clock;
  const t0 = clock.now();
  const inboundResult = await s.ctx.deps.decider.ask(
    inboundQuestions({ offerResponse: b.openOffer !== null, pitchFit: askFit, paid: b.facts.hasUnlocked, disabled: disabledChecks(cfg.route.enabled) }),
    { state: b.jevState, creatorId: s.lease.creatorId },
  );
  s.acc.msJevIn = (s.acc.msJevIn ?? 0) + (clock.now() - t0);
  s.addCost("jev_in", cfg.prices[cfg.jevModel], { ...inboundResult.usage });
  return {
    jevIn: parseInbound(inboundResult, b.openOffer !== null, cfg.route.enabled),
    jevAnswers: Object.fromEntries(inboundResult.answers.map((a) => [a.key, a.value])),
  };
}

/** A strong second-place buy is routed as a buy, and the turn records it was (parsed.promotedFrom). */
export function applyRunnerUp(s: TurnState, b: Batch, jevIn: JevIn): JevIn {
  return b.eventOnly ? jevIn : promoteBuyRunnerUp(jevIn, s.cfg.route.floors.buyIntentRunnerUp);
}
