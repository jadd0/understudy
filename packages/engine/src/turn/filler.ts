import { buildPrompt } from "../drafting/prompt";
import { dropRepeatedEmoji, recentEmoji } from "../drafting/emoji";
import { EMPTY_PROFILE } from "../drafting/memory";
import { verifyDraft } from "../drafting/verify";
import type { JevIn, Route } from "../types";
import { describeError } from "./result";
import type { Batch, TurnState } from "./state";

/**
 * One short line written outside the reply loop: the filler a held chat sends while the creator is away, or the
 * boundary line before a threat is flagged. One draft, the same verify as any reply (a boundary line may refuse),
 * and nothing sent unless every check passes. A failed check or a provider error sends nothing and the stop goes ahead.
 */
export async function draftFiller(s: TurnState, b: Batch, route: Route, thread: JevIn["thread"], boundary: boolean): Promise<string | null> {
  const { ctx, cfg, card, acc } = s;
  const { clock } = ctx.deps;
  const label = boundary ? { boundary: true } : { filler: true };
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
      system: built.system,
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
      },
      () => clock.now(),
    );
    acc.msJevOut = (acc.msJevOut ?? 0) + verdict.ms;
    if (verdict.usage) s.addCost("jev_out", cfg.prices[cfg.jevModel], verdict.usage);
    s.trail.push({ ...label, failures: verdict.failures, answers: verdict.jevOut });
    return verdict.ok && text !== "" ? text : null;
  } catch (e) {
    console.error(`engine: ${boundary ? "boundary line" : "hold filler"} failed ${describeError(e)}`);
    s.trail.push({ ...label, error: describeError(e) });
    return null;
  }
}
