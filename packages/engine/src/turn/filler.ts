import { buildPrompt } from "../drafting/prompt.js";
import { dropRepeatedEmoji, recentEmoji } from "../drafting/emoji.js";
import { EMPTY_PROFILE } from "../drafting/memory.js";
import { ownAccounts, verifyDraft } from "../drafting/verify.js";
import type { JevIn, Route } from "../types.js";
import { HOLD_REFUSAL_LINE, RETRY_NOTE } from "./draft.js";
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
 * sent unless every check passes. A draft that reads as a refusal is written again, within `genAttempts`, with a note
 * that it must not turn him down; any other failure ends the pass. A provider error ends it too and keeps the earlier
 * draft. When no line passes, `held` carries the last non-empty draft.
 */
export async function draftFiller(s: TurnState, b: Batch, route: Route, thread: JevIn["thread"], boundary: boolean): Promise<Filler> {
  const { ctx, cfg, card, acc } = s;
  const { clock } = ctx.deps;
  const label = boundary ? { boundary: true } : { filler: true };
  let held: string | null = null;
  let retry = false;
  for (let attempt = 1; attempt <= cfg.genAttempts; attempt++) {
    try {
      const recent = recentEmoji(b.history);
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
      const t0 = clock.now();
      const gen = await ctx.deps.generator.generate({
        system: retry ? { cached: built.system.cached, turn: `${built.system.turn}${RETRY_NOTE}\n${HOLD_REFUSAL_LINE}` } : built.system,
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
          paid: b.facts.hasUnlocked,
          boundary,
          creatorId: s.lease.creatorId,
          ownAccounts: ownAccounts(card.body),
        },
        () => clock.now(),
      );
      acc.msJevOut = (acc.msJevOut ?? 0) + verdict.ms;
      if (verdict.usage) s.addCost("jev_out", cfg.prices[cfg.jevModel], verdict.usage);
      s.trail.push({ ...label, attempt, failures: verdict.failures, answers: verdict.jevOut });
      if (verdict.ok && text !== "") return { sent: text, held: null };
      if (text !== "") held = text;
      if (!verdict.failures.includes("refusal")) break;
      retry = true;
    } catch (e) {
      console.error(`engine: ${boundary ? "boundary line" : "hold filler"} failed ${describeError(e)}`);
      s.trail.push({ ...label, attempt, error: describeError(e) });
      break;
    }
  }
  return { sent: null, held };
}
