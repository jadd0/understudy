import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { EngineCtx } from "../ctx";
import { ConfigMissing } from "../ports/config";
import { conversations, personaCards, turns } from "../db/schema";
import { getConfig, loadEngineConfig, loadSla, type EngineCfg } from "../config/load";
import { bubbleGap } from "../drafting/bubbles";
import { CostLedger, costMicros } from "./cost";
import { waitForMore, waitForQuiet, type InboundState, type WaitDeps, type WaitStats } from "./debounce";
import { eventJevLines, eventRecord, loadEvents, loadOfferOutcomes, type PendingEvent } from "../conversation/events";
import { loadFacts } from "./facts";
import { canPitch } from "../routing/pacing";
import { commitTurn } from "./commit";
import { emitDelivery } from "./deliver";
import { RETRY_NOTE, RETRY_REASONS, qualityNote } from "./draft";
import { loadHistory, loadInbound, loadTyping, newWorkSince } from "./inbound";
import { NO_FAN_TEXT, tipRowIds, type Candidate, type JevInRecord, type PassResult } from "./pass";
import { describeError, type TurnResult } from "./result";
import { acquireLease, recordFailure, releaseLease, type Lease } from "../conversation/lease";
import type { CommitPlan, TurnRecord } from "./plan";
import { EMPTY_PROFILE, extractMemory, loadProfile } from "../drafting/memory";
import { buildOwnedShortlist, buildShortlist, openOfferId, ownsEverything, pickOffer, type ShortlistItem } from "../conversation/offer";
import { buildPrompt } from "../drafting/prompt";
import { dropRepeatedEmoji, recentEmoji } from "../drafting/emoji";
import { JUST_UNLOCKED_LINE, jevLines, sessionGapMs, type ChatMessage } from "../drafting/thread";
import { inboundQuestions } from "../routing/questions";
import { hardStopOf, parseInbound, promoteBuyRunnerUp, route as decideRoute } from "../routing/route";
import { template, templateSender } from "../drafting/templates";
import type { Facts, JevIn, Route } from "../types";
import { enforceDraw, qualityOnly, verifyDraft, type VerifyFailure } from "../drafting/verify";
import { drawStyle, parseRates } from "../drafting/style-draw";
import { DeciderUnavailable } from "../ports/decider";

/**
 * One turn: lease, wait out the debounce, classify, route, (pick an offer, draft, verify), commit. Provider calls
 * run outside any transaction. Any failure after the lease records an error turn and answers nothing.
 */
export async function runTurn(ctx: EngineCtx, conversationId: string): Promise<TurnResult> {
  const [conv] = await ctx.db.select().from(conversations).where(eq(conversations.id, conversationId));
  if (!conv) return { status: "idle" };
  const leaseMs = await getConfig<number>(ctx, "engine.lease_ms", conv.creatorId);
  // Read before the lease, like the lease length: a failure later in the turn (a missing engine row included)
  // still knows when to hand over, and a missing row here fails the turn before anything is held.
  const maxAttempts = await getConfig<number>(ctx, "engine.max_attempts", conv.creatorId);
  const sla = await loadSla(ctx, conv.creatorId);
  const lease = await acquireLease(ctx, conversationId, leaseMs);
  if (!lease) return { status: "busy" };

  const acc: TurnRecord = {
    inboundIds: [],
    route: null,
    jevIn: null,
    jevOut: null,
    draft: null,
    personaVersion: null,
    models: null,
    tokens: null,
    costMicros: 0,
    msJevIn: null,
    msGen: null,
    msJevOut: null,
    attempts: null,
  };
  try {
    const cfg = await loadEngineConfig(ctx, lease.creatorId);
    return await attemptTurn(ctx, lease, cfg, acc);
  } catch (e) {
    console.error(`engine: turn failed ${describeError(e)}`);
    try {
      const failure = await recordFailure(ctx, lease, acc, maxAttempts, sla);
      return { status: "error", turnId: failure.turnId };
    } catch (inner) {
      console.error(`engine: could not record failure ${describeError(inner)}`);
      await releaseLease(ctx, lease).catch(() => {});
      throw e;
    }
  }
}

async function attemptTurn(ctx: EngineCtx, lease: Lease, cfg: EngineCfg, acc: TurnRecord): Promise<TurnResult> {
  const { decider, retriever, events, clock } = ctx.deps;
  const { host } = ctx;
  const cost = new CostLedger();
  acc.tokens = cost.tokens;
  const addCost = (...args: Parameters<CostLedger["add"]>) => {
    cost.add(...args);
    acc.costMicros = cost.costMicros;
  };
  const models = { jev: cfg.jevModel, generate: cfg.generateModel, memory: cfg.memoryModel };
  acc.models = models;

  const [card] = await ctx.db
    .select()
    .from(personaCards)
    // Only a published card speaks for the creator; a newly loaded version waits until it is published.
    .where(and(eq(personaCards.creatorId, lease.creatorId), isNotNull(personaCards.publishedAt)))
    .orderBy(desc(personaCards.version))
    .limit(1);
  if (!card) throw new ConfigMissing("persona_card");
  // Without stored rates there is no draw and the prompt is unchanged.
  const styleRates = parseRates(card.markers);
  acc.personaVersion = card.version;

  const startedAt = clock.now();
  // A wait or a fold-in starts only while the turn is young enough to finish inside the lease and the sweep.
  const budgetOk = () => clock.now() - startedAt < cfg.turnBudgetMs;
  const stats: WaitStats = { waitedMs: 0, passes: 0 };
  let foldIns = 0;
  let stillTypingReasks = 0;
  const trail: unknown[] = [];
  // The accumulator is written as the loop goes, so a failure on a later attempt keeps what the earlier ones did.
  acc.jevOut = trail;

  let rows: Awaited<ReturnType<typeof loadInbound>> = [];
  let pending: PendingEvent[] = [];
  const waitDeps: WaitDeps = {
    // A tip or an unlock waits out the debounce like a fan message, so a line he writes straight after it is read
    // in the same turn and she answers both at once.
    load: async (): Promise<InboundState> => {
      const [r, ev, typing] = await Promise.all([
        loadInbound(ctx, lease.conversationId),
        loadEvents(ctx, lease.conversationId, cfg.eventWindowMinutes),
        loadTyping(ctx, lease.conversationId),
      ]);
      rows = r;
      pending = ev;
      return { ids: [...r.map((m) => m.id), ...ev.map((e) => e.id)], typing };
    },
    sleep: (ms) => clock.sleep(ms),
  };
  const waitOpts = { debounceMs: cfg.debounceMs, maxMs: cfg.debounceMaxMs };

  const basePlan = (route: Route, declineOfferId: string | null, jevIn: JevInRecord): CommitPlan => {
    acc.jevIn = { ...jevIn, debounce: { waitedMs: stats.waitedMs, passes: stats.passes, foldIns } };
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
        gapMs: bubbleGap(cfg.bubbleGapMsMin, cfg.bubbleGapMsMax, ctx.deps.random ?? Math.random),
      },
    };
  };

  /**
   * One short line written outside the reply loop: the filler a held chat sends while the creator is away, or the
   * boundary line before a threat is flagged. One draft, the same verify as any reply (a boundary line may refuse),
   * and nothing sent unless every check passes. A failed check or a provider error sends nothing and the stop goes ahead.
   */
  const draftFiller = async (
    route: Route,
    history: ChatMessage[],
    facts: Facts,
    sessionGap: number | null,
    jevState: { earlier_messages: ReturnType<typeof jevLines>; new_messages: string[] },
    thread: JevIn["thread"],
    batchText: string,
    boundary = false,
  ): Promise<string | null> => {
    const label = boundary ? { boundary: true } : { filler: true };
    try {
      const recent = recentEmoji(history);
      const built = buildPrompt({
        instruction: boundary ? "threat_boundary" : undefined,
        cardBody: card.body,
        neverList: card.neverList,
        chunks: [],
        profile: EMPTY_PROFILE,
        route,
        offer: null,
        history,
        thread,
        sessionGapMs: sessionGap,
        paid: facts.hasUnlocked,
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
      });
      acc.msGen = (acc.msGen ?? 0) + (clock.now() - t0);
      addCost("generate", cfg.prices[cfg.generateModel], gen.usage);
      const text = dropRepeatedEmoji(gen.text.trim(), recent);
      acc.draft = text;
      const verdict = await verifyDraft(
        decider,
        {
          draft: text,
          fanMessage: batchText,
          earlier: jevState.earlier_messages,
          route: route.name,
          neverList: card.neverList,
          stopReason: gen.stopReason,
          paid: facts.hasUnlocked,
          boundary,
        },
        () => clock.now(),
      );
      acc.msJevOut = (acc.msJevOut ?? 0) + verdict.ms;
      if (verdict.usage) addCost("jev_out", cfg.prices[cfg.jevModel], verdict.usage);
      trail.push({ ...label, failures: verdict.failures, answers: verdict.jevOut });
      return verdict.ok && text !== "" ? text : null;
    } catch (e) {
      console.error(`engine: ${boundary ? "boundary line" : "hold filler"} failed ${describeError(e)}`);
      trail.push({ ...label, error: describeError(e) });
      return null;
    }
  };

  /** One read of the chat: wait for the fan to settle, classify, route, and (when the route speaks) draft and verify. */
  const runPass = async (): Promise<PassResult> => {
    let state: InboundState;
    let history: ChatMessage[];
    let facts: Facts;
    let inboundIds: Set<string>;
    let batchText: string;
    let sessionGap: number | null;
    let jevState: { earlier_messages: ReturnType<typeof jevLines>; new_messages: string[] };
    let jevIn: JevIn;
    let jevAnswers: Record<string, string>;
    let openOffer: string | null;
    let reacting: PendingEvent[];
    let eventOnly: boolean;
    for (;;) {
      state = await waitForQuiet(waitDeps, waitOpts, stats);
      if (rows.length === 0 && pending.length === 0) return { kind: "idle" };
      eventOnly = rows.length === 0;
      acc.inboundIds = rows.map((m) => m.id);
      inboundIds = new Set(acc.inboundIds);
      // Fan text only: a tip row's body carries the amount and must reach neither memory, retrieval nor Jev.
      batchText = rows.map((m) => m.body).join("\n");

      history = await loadHistory(ctx, lease.conversationId, cfg.historyRounds);
      const loaded = await loadFacts(ctx, lease.conversationId, lease.fanId, lease.creatorId, cfg);
      sessionGap = sessionGapMs(history, inboundIds, cfg.gapMarkerMinutes);
      facts = { ...loaded, sessionStart: sessionGap !== null };
      // In a hardship cooldown she does not thank him for spending: the events are left unstamped and age out.
      reacting = facts.noPitchActive ? [] : pending;
      if (eventOnly && reacting.length === 0) return { kind: "idle" };
      openOffer = facts.hasOpenOffer ? await openOfferId(ctx, lease.conversationId) : null;

      // Jev sees the new messages and a little earlier context: no card, no prices, no memory.
      const reactsToUnlock = reacting.some((e) => e.kind === "unlock");
      jevState = {
        // An unlock leaves no chat line; without this, "that was cute of you" after a purchase reads as a hedge.
        earlier_messages: [
          ...jevLines(history, inboundIds, { rounds: cfg.jevContextRounds, gapMinutes: cfg.gapMarkerMinutes }),
          ...(facts.justUnlocked && !reactsToUnlock ? [{ from: "platform" as const, text: JUST_UNLOCKED_LINE }] : []),
          ...eventJevLines(reacting),
        ],
        new_messages: rows.map((m) => m.body),
      };
      if (eventOnly) {
        // Nothing he wrote to classify: no safety read, no pitch, a plain reaction.
        jevIn = NO_FAN_TEXT;
        jevAnswers = {};
        break;
      }
      // pitch_fit is only worth a question when pacing and the chat leave room for an AI-initiated pitch.
      const askFit = canPitch(facts, cfg.route, "smalltalk").ok && !facts.hasOpenOffer && !facts.sessionStart;

      const t0 = clock.now();
      const inboundResult = await decider.ask(inboundQuestions({ offerResponse: openOffer !== null, pitchFit: askFit, paid: facts.hasUnlocked }), { state: jevState });
      acc.msJevIn = (acc.msJevIn ?? 0) + (clock.now() - t0);
      addCost("jev_in", cfg.prices[cfg.jevModel], { ...inboundResult.usage });
      jevIn = parseInbound(inboundResult, openOffer !== null);
      jevAnswers = Object.fromEntries(inboundResult.answers.map((a) => [a.key, a.value]));

      // His words stop mid-thought: give him time to finish, and read the whole batch again if he does.
      // A hard stop is never delayed; hardship alone does not hand the chat over, so it may wait.
      const hardStop = hardStopOf(jevIn.p, cfg.route.floors) !== null;
      if (jevIn.thread === "still_typing" && !hardStop && stillTypingReasks < cfg.foldInMax) {
        const more = await waitForMore(waitDeps, { ...waitOpts, canStart: budgetOk }, stats, state);
        if (more) {
          stillTypingReasks++;
          continue;
        }
      }
      break;
    }

    // A strong second-place buy is routed as a buy, and the turn records it was (parsed.promotedFrom).
    if (!eventOnly) jevIn = promoteBuyRunnerUp(jevIn, cfg.route.floors.buyIntentRunnerUp);
    const declineOfferId = jevIn.offerResponse === "declines" ? openOffer : null;
    // A decline in this very message counts toward the pitch limit now, not on the next turn.
    const routingFacts: Facts = declineOfferId ? { ...facts, declinesInWindow: facts.declinesInWindow + 1 } : facts;
    let route: Route = eventOnly ? { name: "reply", hardship: false, alert: false } : decideRoute(jevIn, routingFacts, cfg.route);
    // A fan in hardship is not thanked for spending; the events stay unstamped and age out.
    if (route.hardship) reacting = [];
    // Thanks or a check-in never carries a new offer: an offer route answers in words alone this turn.
    if (reacting.length > 0 && route.name === "offer") route = { ...route, name: route.fallback ?? "reply" };
    acc.route = route.name;
    const ids = acc.inboundIds;
    const seenKeys = state.ids;
    const record: JevInRecord = { parsed: eventOnly ? null : jevIn, answers: jevAnswers, events: eventRecord(reacting) };
    acc.jevIn = record;

    if (route.name === "hard_stop" || route.name === "hold_creator") {
      const plan = basePlan(route, declineOfferId, record);
      // A human owns the chat now and sees the tip row; it is not left queued for a later AI thanks.
      plan.eventMessageIds = tipRowIds(reacting);
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
          const line = await draftFiller(route, history, facts, sessionGap, jevState, jevIn.thread, batchText, true);
          if (line) plan.reply = { body: line, kind: "sent" };
        }
      } else {
        plan.outcome = "handoff";
        plan.setMode = "handoff_creator";
        plan.handoff = { queue: "creator", reason: route.reason! };
        const filler = await draftFiller(route, history, facts, sessionGap, jevState, jevIn.thread, batchText);
        if (filler) plan.reply = { body: filler, kind: "sent" };
      }
      return { kind: "final", plan, batchText, route };
    }

    // Independent reads, side by side: each is a round trip to the database (or the retriever).
    const [profile, chunks, offerOutcomes, ownsAll] = await Promise.all([
      loadProfile(ctx, lease.creatorId, lease.fanId),
      // No fan text, nothing to retrieve on.
      eventOnly
        ? []
        : retriever.retrieve(lease.creatorId, batchText, cfg.retrievalK).catch((e) => {
            console.error(`engine: retrieval failed ${describeError(e)}`);
            return [];
          }),
      loadOfferOutcomes(ctx, lease.conversationId, lease.fanId, cfg.offerHistoryCount),
      ownsEverything(host, lease.creatorId, lease.fanId),
    ]);

    let offerItem: ShortlistItem | null = null;
    if (route.name === "offer") {
      try {
        // Only items the debit would accept: the same cap rule, so an offer is never one the cap then refuses.
        const affordable = (items: ShortlistItem[]) => items.filter((it) => host.capAllows(facts.spentTodayCents, it.priceCents, facts.capCents));
        const unowned = affordable(await buildShortlist(host, lease.creatorId, lease.fanId, lease.conversationId, route.offerKinds));
        // Nothing new he can take: offer something he already owns, a favourite worth unlocking again. It is charged
        // like any purchase, so the same cap rule applies.
        const shortlist =
          unowned.length > 0 ? unowned : affordable(await buildOwnedShortlist(host, lease.creatorId, lease.fanId, lease.conversationId, route.offerKinds));
        const t0 = clock.now();
        const pick = await pickOffer(decider, shortlist, jevState);
        acc.msJevIn = (acc.msJevIn ?? 0) + (clock.now() - t0);
        if (pick.usage) addCost("offer_pick", cfg.prices[cfg.jevModel], pick.usage);
        offerItem = pick.item;
      } catch (e) {
        if (!(e instanceof DeciderUnavailable)) throw e;
        // No usable pick: answer without an offer.
      }
      if (!offerItem) route = { ...route, name: route.fallback ?? "reply" };
      acc.route = route.name;
    }

    let draft = "";
    let ok = false;
    let attempts = 0;
    let chosen: string | null = null;
    // The chosen draft never led into the offer: it is sent without the card.
    let chosenUnsetup = false;
    let previous: VerifyFailure[] = [];
    const recent = recentEmoji(history);
    // One draw per reply, kept across retries; the fixed-line routes never draw.
    const styleDraw =
      styleRates && ["reply", "offer", "deflect"].includes(route.name) ? drawStyle(styleRates, batchText, ctx.deps.random ?? Math.random) : null;
    if (styleDraw) trail.push({ style: styleDraw });
    while (attempts < cfg.genAttempts && !ok) {
      attempts++;
      acc.attempts = attempts;
      const built = buildPrompt({
        cardBody: card.body,
        neverList: card.neverList,
        chunks,
        profile,
        route,
        offer: offerItem,
        history,
        thread: jevIn.thread,
        sessionGapMs: sessionGap,
        paid: facts.hasUnlocked,
        recentEmoji: recent,
        historyRounds: cfg.historyRounds,
        gapMarkerMinutes: cfg.gapMarkerMinutes,
        events: reacting,
        eventOnly,
        offerOutcomes,
        // A cooldown turn never hears "tease that more is coming".
        ownsAll: ownsAll && !facts.noPitchActive,
        styleDraw: styleDraw && styleRates ? { draw: styleDraw, pet: styleRates.pet } : undefined,
      });
      // Name what failed, so the second draft drops that part instead of rephrasing it (a lobby invite became a voice-note dare).
      const reasons = previous.map((f) => RETRY_REASONS[f]).filter(Boolean);
      const note = attempts === 1 ? "" : qualityOnly(previous) ? qualityNote(previous) : RETRY_NOTE + (reasons.length ? `\n${reasons.join("\n")}` : "");
      let verdict: Awaited<ReturnType<typeof verifyDraft>>;
      try {
        const t0 = clock.now();
        const gen = await ctx.deps.generator.generate({
          system: { cached: built.system.cached, turn: built.system.turn + note },
          messages: built.messages,
          maxTokens: cfg.maxTokens,
          model: cfg.generateModel,
        });
        acc.msGen = (acc.msGen ?? 0) + (clock.now() - t0);
        // Priced at the model that served, not the one asked for: a failover answers from its fallback at that model's rows.
        const servedPrices = cfg.prices[gen.model];
        if (!servedPrices) throw new ConfigMissing(`price.${gen.model}.input_per_mtok`);
        addCost("generate", servedPrices, gen.usage);
        // An emoji she just used is dropped even if the model repeats it after being told not to.
        draft = dropRepeatedEmoji(gen.text.trim(), recent);
        acc.draft = draft;

        verdict = await verifyDraft(
          decider,
          {
            draft,
            fanMessage: batchText,
            earlier: jevState.earlier_messages,
            route: route.name,
            neverList: card.neverList,
            stopReason: gen.stopReason,
            paid: facts.hasUnlocked,
            offer: offerItem,
            boundary: route.name === "boundary",
          },
          () => clock.now(),
        );
      } catch (e) {
        // A provider error on a retry never costs a safe draft already in hand: stop retrying and send that one.
        // A boundary line never fails the turn: the fixed template goes instead, so the fan always hears one.
        if (chosen === null && route.name !== "boundary") throw e;
        console.error(`engine: attempt ${attempts} failed, ${chosen === null ? "using the fixed boundary line" : "keeping an earlier safe draft"} ${describeError(e)}`);
        trail.push({ attempt: attempts, error: describeError(e) });
        break;
      }
      acc.msJevOut = (acc.msJevOut ?? 0) + verdict.ms;
      if (verdict.usage) addCost("jev_out", cfg.prices[cfg.jevModel], verdict.usage);
      trail.push({ attempt: attempts, failures: verdict.failures, answers: verdict.jevOut });
      // A draft that only repeats a question is still safe: if no later attempt does better, it is the one sent.
      if (verdict.ok || qualityOnly(verdict.failures)) {
        chosen = styleDraw ? enforceDraw(draft, styleDraw) : draft;
        chosenUnsetup = verdict.failures.includes("offer_unsetup");
      }
      previous = verdict.failures;
      ok = verdict.ok;
    }

    const failed = { route, batchText, declineOfferId, record, events: reacting };
    if (chosen === null) return { kind: "draft", candidate: null, lastDraft: draft, failed };
    if (chosenUnsetup) {
      // An offer card straight after a message that never mentions it reads as a cold sales push: send the words alone.
      route = { ...route, name: route.fallback ?? "reply" };
      offerItem = null;
      acc.route = route.name;
    }
    return {
      kind: "draft",
      candidate: { draft: chosen, route, offerItem, inboundIds: ids, events: reacting, seenKeys, batchText, jevIn: record, declineOfferId, attempts },
      lastDraft: draft,
      failed,
    };
  };

  let safe: Candidate | null = null;
  let plan: CommitPlan;
  let route: Route;
  let batchText: string;
  for (;;) {
    let pass: PassResult;
    try {
      pass = await runPass();
    } catch (e) {
      // A fold-in pass that errors leaves the earlier safe draft standing for its own batch, as one that finds
      // nothing safe does; the late messages wait for the next turn.
      if (!safe) throw e;
      console.error(`engine: fold-in pass failed, keeping the earlier safe draft ${describeError(e)}`);
      trail.push({ passError: describeError(e) });
      break;
    }
    if (pass.kind === "idle") {
      if (!safe) {
        await releaseLease(ctx, lease);
        return { status: "idle" };
      }
      break;
    }
    if (pass.kind === "final") {
      ({ plan, route, batchText } = pass);
      return finish(plan, route, batchText);
    }
    if (pass.candidate) {
      safe = pass.candidate;
      const late = foldIns < cfg.foldInMax && budgetOk() ? await newWorkSince(ctx, lease.conversationId, safe.seenKeys, cfg.eventWindowMinutes) : false;
      if (late) {
        // He wrote, tipped or unlocked while she was drafting: throw this draft away and answer the whole batch.
        foldIns++;
        trail.push({ folded: true });
        continue;
      }
      break;
    }
    if (safe) break; // A later pass found nothing safe: the earlier draft, for the earlier batch, still stands.
    plan = basePlan(pass.failed.route, pass.failed.declineOfferId, pass.failed.record);
    if (pass.failed.route.name === "boundary") {
      // No boundary line passed safety: the fixed line goes, with the same warning, and the AI keeps chatting.
      plan.reply = { body: template("location_offplatform", cfg.supportEmail), kind: "sent", fixed: true };
      return finish(plan, pass.failed.route, pass.failed.batchText);
    }
    // No attempt in the turn passed safety: hold the last draft for the creator to edit and hand the conversation over.
    plan.outcome = "suggested";
    plan.reply = { body: pass.lastDraft, kind: "draft" };
    plan.setMode = "handoff_creator";
    plan.handoff = { queue: "creator", reason: "verify_failed" };
    plan.eventMessageIds = tipRowIds(pass.failed.events);
    return finish(plan, pass.failed.route, pass.failed.batchText);
  }

  // Commit the newest draft that passed safety, restoring the context it was written for.
  const c = safe!;
  acc.inboundIds = c.inboundIds;
  acc.draft = c.draft;
  acc.attempts = c.attempts;
  plan = basePlan(c.route, c.declineOfferId, c.jevIn);
  plan.reply = { body: c.draft, kind: "sent" };
  plan.eventMessageIds = tipRowIds(c.events);
  if (c.offerItem && c.route.name === "offer") {
    plan.offer = { itemId: c.offerItem.id, priceCents: c.offerItem.priceCents, ttlMinutes: cfg.offerTtlMinutes };
  }
  return finish(plan, c.route, c.batchText);

  async function finish(p: CommitPlan, r: Route, text: string): Promise<TurnResult> {
    const result = await commitTurn(ctx, lease, p);
    if (result.applied) {
      // The console inbox (preview, time, badge) refreshes on this; a reply, a hold or a hard stop all change it.
      await events
        .emit(`creator:${lease.creatorId}`, "inbox.changed", { conversationId: lease.conversationId })
        .catch((e) => console.error(`engine: emit failed ${describeError(e)}`));
    }
    // A hard stop's template is delivered even when the commit lost the race.
    if (p.reply?.kind === "sent" || p.strike) await emitDelivery(events, lease.conversationId, result);
    if (!result.applied) return { status: "superseded", turnId: result.turnId };

    // A reaction to a tip or an unlock has no fan text to learn from.
    if ((p.outcome === "replied" || p.outcome === "suggested") && text.trim() !== "") {
      try {
        const usage = await extractMemory(ctx, {
          creatorId: lease.creatorId,
          fanId: lease.fanId,
          fanText: text,
          model: cfg.memoryModel,
          maxTokens: cfg.maxTokens,
        });
        if (usage) {
          const micros = costMicros(cfg.prices[cfg.memoryModel], usage);
          await ctx.db
            .update(turns)
            .set({
              costMicros: sql`${turns.costMicros} + ${micros}`,
              tokens: sql`coalesce(${turns.tokens}, '{}'::jsonb) || ${JSON.stringify({ memory: usage })}::jsonb`,
            })
            .where(eq(turns.id, result.turnId));
        }
      } catch (e) {
        console.error(`engine: memory failed ${describeError(e)}`);
      }
    }
    return { status: "committed", turnId: result.turnId, route: r.name, outcome: p.outcome, creatorId: lease.creatorId };
  }
}

