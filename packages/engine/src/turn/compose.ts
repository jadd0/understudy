import { ConfigMissing } from "../ports/config.js";
import { loadOfferOutcomes } from "../conversation/events.js";
import { ownsEverything, type ShortlistItem } from "../conversation/offer.js";
import { dropRepeatedEmoji, recentEmoji } from "../drafting/emoji.js";
import { loadProfile } from "../drafting/memory.js";
import { buildPrompt } from "../drafting/prompt.js";
import { drawFailures, enforceDraw, qualityOnly, verifyDraft, type VerifyFailure } from "../drafting/verify.js";
import { drawStyle, parseRates } from "../drafting/style-draw.js";
import type { JevIn, Route } from "../types.js";
import { RETRY_NOTE, RETRY_REASONS, drawReasons, qualityNote } from "./draft.js";
import type { PassResult } from "./pass.js";
import { describeError } from "./result.js";
import type { Routed } from "./route.js";
import type { Batch, TurnState } from "./state.js";

/** What the reply is written from besides the chat itself: the fan's memory, retrieved chunks, offer history. */
export type DraftInputs = {
  profile: Awaited<ReturnType<typeof loadProfile>>;
  chunks: Awaited<ReturnType<TurnState["ctx"]["deps"]["retriever"]["retrieve"]>>;
  offerOutcomes: Awaited<ReturnType<typeof loadOfferOutcomes>>;
  ownsAll: boolean;
};

/** Independent reads, side by side: each is a round trip to the database (or the retriever). */
export async function loadDraftInputs(s: TurnState, b: Batch): Promise<DraftInputs> {
  const { ctx, lease, cfg } = s;
  const [profile, chunks, offerOutcomes, ownsAll] = await Promise.all([
    loadProfile(ctx, lease.creatorId, lease.fanId),
    // No fan text, nothing to retrieve on.
    b.eventOnly
      ? []
      : ctx.deps.retriever.retrieve(lease.creatorId, b.batchText, cfg.retrievalK).catch((e) => {
          console.error(`engine: retrieval failed ${describeError(e)}`);
          return [];
        }),
    loadOfferOutcomes(ctx, lease.conversationId, lease.fanId, cfg.offerHistoryCount),
    ownsEverything(ctx.host, lease.creatorId, lease.fanId),
  ]);
  return { profile, chunks, offerOutcomes, ownsAll };
}

/**
 * Drafts the reply, up to `genAttempts` times, and has Jev verify each draft. The pass ends with the last draft that
 * passed safety (a quality-only failure still counts) as the candidate, or none for the creator to edit.
 */
export async function composeReply(
  s: TurnState,
  b: Batch,
  r: Routed,
  inputs: DraftInputs,
  picked: { route: Route; offerItem: ShortlistItem | null },
  thread: JevIn["thread"],
): Promise<PassResult> {
  const { ctx, cfg, card, acc, lease } = s;
  const { clock, decider } = ctx.deps;
  let { route, offerItem } = picked;
  let draft = "";
  let ok = false;
  let attempts = 0;
  let chosen: string | null = null;
  // The chosen draft never led into the offer: it is sent without the card.
  let chosenUnsetup = false;
  let previous: VerifyFailure[] = [];
  const recent = recentEmoji(b.history);
  // Without stored rates there is no draw and the prompt is unchanged.
  const styleRates = parseRates(card.markers);
  // One draw per reply, kept across retries; the fixed-line routes never draw.
  const styleDraw =
    styleRates && ["reply", "offer", "deflect"].includes(route.name) ? drawStyle(styleRates, b.batchText, ctx.deps.random ?? Math.random) : null;
  if (styleDraw) s.trail.push({ style: styleDraw });
  while (attempts < cfg.genAttempts && !ok) {
    attempts++;
    acc.attempts = attempts;
    const built = buildPrompt({
      cardBody: card.body,
      neverList: card.neverList,
      chunks: inputs.chunks,
      profile: inputs.profile,
      route,
      offer: offerItem,
      history: b.history,
      thread,
      sessionGapMs: b.sessionGap,
      paid: b.facts.hasUnlocked,
      recentEmoji: recent,
      historyRounds: cfg.historyRounds,
      gapMarkerMinutes: cfg.gapMarkerMinutes,
      events: r.reacting,
      eventOnly: b.eventOnly,
      offerOutcomes: inputs.offerOutcomes,
      // A cooldown turn never hears "tease that more is coming".
      ownsAll: inputs.ownsAll && !b.facts.noPitchActive,
      styleDraw: styleDraw && styleRates ? { draw: styleDraw, pet: styleRates.pet } : undefined,
    });
    // Name what failed, so the second draft drops that part instead of rephrasing it (a lobby invite became a voice-note dare).
    const drawNote = { targetChars: styleDraw?.targetChars, pet: styleRates?.pet };
    const reasons = [...previous.map((f) => RETRY_REASONS[f]), ...drawReasons(previous, drawNote)].filter(Boolean);
    const note = attempts === 1 ? "" : qualityOnly(previous) ? qualityNote(previous, drawNote) : RETRY_NOTE + (reasons.length ? `\n${reasons.join("\n")}` : "");
    let verdict: Awaited<ReturnType<typeof verifyDraft>>;
    try {
      const t0 = clock.now();
      const gen = await ctx.deps.generator.generate({
        system: { cached: built.system.cached, turn: built.system.turn + note },
        messages: built.messages,
        maxTokens: cfg.maxTokens,
        model: cfg.generateModel,
        creatorId: lease.creatorId,
      });
      acc.msGen = (acc.msGen ?? 0) + (clock.now() - t0);
      // Priced at the model that served, not the one asked for: a failover answers from its fallback at that model's rows.
      const servedPrices = cfg.prices[gen.model];
      if (!servedPrices) throw new ConfigMissing(`price.${gen.model}.input_per_mtok`);
      s.addCost("generate", servedPrices, gen.usage);
      // An emoji she just used is dropped even if the model repeats it after being told not to.
      draft = dropRepeatedEmoji(gen.text.trim(), recent);
      acc.draft = draft;

      verdict = await verifyDraft(
        decider,
        {
          draft,
          fanMessage: b.batchText,
          earlier: b.jevState.earlier_messages,
          route: route.name,
          neverList: card.neverList,
          stopReason: gen.stopReason,
          paid: b.facts.hasUnlocked,
          offer: offerItem,
          boundary: route.name === "boundary",
          creatorId: lease.creatorId,
        },
        () => clock.now(),
      );
    } catch (e) {
      // A provider error on a retry never costs a safe draft already in hand: stop retrying and send that one.
      // A boundary line never fails the turn: the fixed template goes instead, so the fan always hears one.
      if (chosen === null && route.name !== "boundary") throw e;
      console.error(`engine: attempt ${attempts} failed, ${chosen === null ? "using the fixed boundary line" : "keeping an earlier safe draft"} ${describeError(e)}`);
      s.trail.push({ attempt: attempts, error: describeError(e) });
      break;
    }
    acc.msJevOut = (acc.msJevOut ?? 0) + verdict.ms;
    if (verdict.usage) s.addCost("jev_out", cfg.prices[cfg.jevModel], verdict.usage);
    // The draw's length and pet limits are judged on the text that would be sent, after the edge clean-up.
    const sendable = styleDraw ? enforceDraw(draft, styleDraw) : draft;
    const failures = [...verdict.failures, ...drawFailures(sendable, styleDraw, styleRates)];
    s.trail.push({ attempt: attempts, failures, answers: verdict.jevOut });
    // A draft that only repeats a question or runs over the draw is still safe: if no later attempt does better, it is the one sent.
    if (failures.length === 0 || qualityOnly(failures)) {
      chosen = sendable;
      chosenUnsetup = failures.includes("offer_unsetup");
    }
    previous = failures;
    ok = failures.length === 0;
  }

  const failed = { route, batchText: b.batchText, declineOfferId: r.declineOfferId, record: r.record, events: r.reacting };
  if (chosen === null) return { kind: "draft", candidate: null, lastDraft: draft, failed };
  if (chosenUnsetup) {
    // An offer card straight after a message that never mentions it reads as a cold sales push: send the words alone.
    route = { ...route, name: route.fallback ?? "reply" };
    offerItem = null;
    acc.route = route.name;
  }
  return {
    kind: "draft",
    candidate: {
      draft: chosen,
      route,
      offerItem,
      inboundIds: acc.inboundIds,
      events: r.reacting,
      seenKeys: b.state.ids,
      batchText: b.batchText,
      jevIn: r.record,
      declineOfferId: r.declineOfferId,
      attempts,
    },
    lastDraft: draft,
    failed,
  };
}
