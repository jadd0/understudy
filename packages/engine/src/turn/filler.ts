import { buildPrompt } from "../drafting/prompt.js";
import { dropRepeatedEmoji, recentEmoji } from "../drafting/emoji.js";
import { EMPTY_PROFILE } from "../drafting/memory.js";
import { ownAccounts, qualityOnly, verifyDraft, type VerifyFailure } from "../drafting/verify.js";
import type { JevIn, Route } from "../types.js";
import { fillerRetryNote } from "./draft.js";
import { describeError } from "./result.js";
import type { Batch, TurnState } from "./state.js";

/** What a filler pass produced: the line that passed every check, and the last draft kept when none did. */
export interface Filler {
  /** A line that passed verify; the only text that may reach the fan. */
  sent: string | null;
  /** The last non-empty draft when no attempt passed, for the creator to edit. Never sent. */
  held: string | null;
}

/**
 * One short line written outside the reply loop: the filler a held chat sends while the creator is away, or the
 * boundary line before a threat is flagged. The same verify as any reply (a boundary line may refuse), and nothing is
 * sent unless every safety check passes. A draft that fails is written again, within `genAttempts`, with a note naming
 * each failure (a refusal is told not to turn him down). A draft whose only failures are quality ones is still safe: it
 * is sent if no later attempt does better, as a reply is. A provider error ends the pass and keeps what is in hand.
 * When no line is safe, `held` carries the last non-empty draft.
 */
export async function draftFiller(s: TurnState, b: Batch, route: Route, thread: JevIn["thread"], boundary: boolean): Promise<Filler> {
  const { ctx, cfg, card, acc } = s;
  const { clock } = ctx.deps;
  const label = boundary ? { boundary: true } : { filler: true };
  // Nothing in the prompt or the accounts changes between attempts; only the retry note does.
  const recent = recentEmoji(b.history);
  const accounts = ownAccounts(card.body);
  const built = buildPrompt({
    instruction: boundary ? "threat_boundary" : undefined,
    cardBody: card.body,
    neverList: card.neverList,
    chunks: [],
    profile: EMPTY_PROFILE,
    route,
    offer: null,
    history: b.history,
    thread,
    sessionGapMs: b.sessionGap,
    paid: b.facts.hasUnlocked,
    recentEmoji: recent,
    historyRounds: cfg.historyRounds,
    gapMarkerMinutes: cfg.gapMarkerMinutes,
  });
  let held: string | null = null;
  // The latest draft that failed only quality checks: safe to send when nothing better follows.
  let safe: string | null = null;
  let previous: VerifyFailure[] = [];
  for (let attempt = 1; attempt <= cfg.genAttempts; attempt++) {
    try {
      const t0 = clock.now();
      const gen = await ctx.deps.generator.generate({
        system: attempt === 1 ? built.system : { cached: built.system.cached, turn: `${built.system.turn}${fillerRetryNote(previous)}` },
        messages: built.messages,
        maxTokens: cfg.maxTokens,
        model: cfg.generateModel,
        creatorId: s.lease.creatorId,
      });
      acc.msGen = (acc.msGen ?? 0) + (clock.now() - t0);
      s.addCost("generate", cfg.prices[cfg.generateModel], gen.usage);
      const text = dropRepeatedEmoji(gen.text.trim(), recent);
      acc.draft = text;
      const verdict = await verifyDraft(
        ctx.deps.decider,
        {
          draft: text,
          fanMessage: b.batchText,
          earlier: b.jevState.earlier_messages,
          route: route.name,
          neverList: card.neverList,
          stopReason: gen.stopReason,
          boundary,
          creatorId: s.lease.creatorId,
          ownAccounts: accounts,
        },
        () => clock.now(),
      );
      acc.msJevOut = (acc.msJevOut ?? 0) + verdict.ms;
      if (verdict.usage) s.addCost("jev_out", cfg.prices[cfg.jevModel], verdict.usage);
      s.trail.push({ ...label, attempt, failures: verdict.failures, answers: verdict.jevOut });
      if (verdict.ok && text !== "") return { sent: text, held: null };
      if (text !== "") {
        held = text;
        if (qualityOnly(verdict.failures)) safe = text;
      }
      previous = verdict.failures;
    } catch (e) {
      console.error(`engine: ${boundary ? "boundary line" : "hold filler"} failed ${describeError(e)}`);
      s.trail.push({ ...label, attempt, error: describeError(e) });
      break;
    }
  }
  return safe !== null ? { sent: safe, held: null } : { sent: null, held };
}
