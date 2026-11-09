import { eventJevLines, loadEvents } from "../conversation/events";
import { openOfferId } from "../conversation/offer";
import { JUST_UNLOCKED_LINE, jevLines, sessionGapMs } from "../drafting/thread";
import { hardStopOf } from "../routing/route";
import { canPitch } from "../routing/pacing";
import type { Facts } from "../types";
import { classifyInbound } from "./classify";
import { waitForMore, waitForQuiet, type InboundState, type WaitDeps } from "./debounce";
import { loadFacts } from "./facts";
import { loadHistory, loadInbound, loadTyping } from "./inbound";
import { NO_FAN_TEXT } from "./pass";
import type { Batch, Classified, TurnState } from "./state";

/** What one read of the chat settled on: the batch, and Jev's read of it. */
export type Read = { kind: "idle" } | { kind: "read"; batch: Batch; classified: Classified };

/**
 * Waits for the fan to settle, loads the chat around the new messages and classifies them. When his words stop
 * mid-thought it gives him time to finish and reads the whole batch again if he does.
 */
export async function readBatch(s: TurnState): Promise<Read> {
  const { ctx, lease, cfg } = s;
  const waitDeps: WaitDeps = {
    // A tip or an unlock waits out the debounce like a fan message, so a line he writes straight after it is read
    // in the same turn and she answers both at once.
    load: async (): Promise<InboundState> => {
      const [r, ev, typing] = await Promise.all([
        loadInbound(ctx, lease.conversationId),
        loadEvents(ctx, lease.conversationId, cfg.eventWindowMinutes),
        loadTyping(ctx, lease.conversationId),
      ]);
      s.rows = r;
      s.pending = ev;
      return { ids: [...r.map((m) => m.id), ...ev.map((e) => e.id)], typing };
    },
    sleep: (ms) => ctx.deps.clock.sleep(ms),
  };
  const waitOpts = { debounceMs: cfg.debounceMs, maxMs: cfg.debounceMaxMs };

  for (;;) {
    const state = await waitForQuiet(waitDeps, waitOpts, s.stats);
    if (s.rows.length === 0 && s.pending.length === 0) return { kind: "idle" };
    const eventOnly = s.rows.length === 0;
    s.acc.inboundIds = s.rows.map((m) => m.id);
    const inboundIds = new Set(s.acc.inboundIds);
    // Fan text only: a tip row's body carries the amount and must reach neither memory, retrieval nor Jev.
    const batchText = s.rows.map((m) => m.body).join("\n");

    const history = await loadHistory(ctx, lease.conversationId, cfg.historyRounds);
    const loaded = await loadFacts(ctx, lease.conversationId, lease.fanId, lease.creatorId, cfg);
    const sessionGap = sessionGapMs(history, inboundIds, cfg.gapMarkerMinutes);
    const facts: Facts = { ...loaded, sessionStart: sessionGap !== null };
    // In a hardship cooldown she does not thank him for spending: the events are left unstamped and age out.
    const reacting = facts.noPitchActive ? [] : s.pending;
    if (eventOnly && reacting.length === 0) return { kind: "idle" };
    const openOffer = facts.hasOpenOffer ? await openOfferId(ctx, lease.conversationId) : null;

    // Jev sees the new messages and a little earlier context: no card, no prices, no memory.
    const reactsToUnlock = reacting.some((e) => e.kind === "unlock");
    const jevState = {
      // An unlock leaves no chat line; without this, "that was cute of you" after a purchase reads as a hedge.
      earlier_messages: [
        ...jevLines(history, inboundIds, { rounds: cfg.jevContextRounds, gapMinutes: cfg.gapMarkerMinutes }),
        ...(facts.justUnlocked && !reactsToUnlock ? [{ from: "platform" as const, text: JUST_UNLOCKED_LINE }] : []),
        ...eventJevLines(reacting),
      ],
      new_messages: s.rows.map((m) => m.body),
    };
    const batch: Batch = { state, history, facts, inboundIds, batchText, sessionGap, jevState, openOffer, reacting, eventOnly };
    // Nothing he wrote to classify: no safety read, no pitch, a plain reaction.
    if (eventOnly) return { kind: "read", batch, classified: { jevIn: NO_FAN_TEXT, jevAnswers: {} } };

    // pitch_fit is only worth a question when pacing and the chat leave room for an AI-initiated pitch.
    const askFit = canPitch(facts, cfg.route, "smalltalk").ok && !facts.hasOpenOffer && !facts.sessionStart;
    const classified = await classifyInbound(s, batch, askFit);

    // A hard stop is never delayed; hardship alone does not hand the chat over, so it may wait.
    const hardStop = hardStopOf(classified.jevIn.p, cfg.route.floors, cfg.route.enabled) !== null;
    if (classified.jevIn.thread === "still_typing" && !hardStop && s.stillTypingReasks < cfg.foldInMax) {
      const more = await waitForMore(waitDeps, { ...waitOpts, canStart: s.budgetOk }, s.stats, state);
      if (more) {
        s.stillTypingReasks++;
        continue;
      }
    }
    return { kind: "read", batch, classified };
  }
}
