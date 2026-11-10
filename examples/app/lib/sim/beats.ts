import { and, desc, eq, sql } from "drizzle-orm";
import { db, withTx } from "@/db/client";
import { offers, wallets } from "@/db/schema";
import { sendFanMessage, SendRefused } from "@/lib/chat/send";
import { dbConfigPort, getConfig } from "@/lib/config";
import { understudyFor } from "@/lib/host/deps";
import { dbHost } from "@/lib/host/engine-host";
import { loadFacts } from "@jadd0/understudy-engine/internal";
import { setFanCap } from "@/lib/wallet/cap";
import { ledgerSum } from "@/lib/wallet/ledger";
import { tip } from "@/lib/wallet/tip";
import { tipInChat, unlockInChat } from "@/lib/chat/react";
import { agentStep, readFanView, conversationOf } from "./agent";
import type { SimDeps } from "./deps";
import { expectedState, humanAct, type HumanCtx } from "./humans";
import { observe, readBefore } from "./observe";
import type { Beat, Persona } from "./persona";
import type { Variant } from "./random";
import { emptyScore, scoreBeat, type BeatResult, type SimFailure } from "./score";

type Kind<K extends Beat["kind"]> = Extract<Beat, { kind: K }>;

export interface BeatEnv {
  runId: string;
  mode: "demo" | "auto";
  persona: Persona;
  variant: Variant;
  seed: string;
  deps: SimDeps;
  fanId: string;
  creatorId: string;
  humans: HumanCtx;
  /** Sim model spend of this beat, added to the run's cost by the caller. */
  micros: number;
}

export interface BeatOutcome {
  result: BeatResult;
  /** The run should stop after this beat, with this reason. */
  stop?: string;
}

const ENGINE_LINE = /^engine: (.+)$/;

/** Captures the engine's `engine: <class> <code>` failure lines while `fn` runs; they are class and code only. */
async function captureEngineErrors<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    const m = ENGINE_LINE.exec(String(args[0]));
    if (m) lines.push(m[1]);
    else original(...args);
  };
  try {
    return { value: await fn(), lines };
  } finally {
    console.error = original;
  }
}

const result = (index: number, beat: Beat, status: BeatResult["status"], over: Partial<BeatResult> = {}): BeatResult => ({
  index,
  kind: beat.kind,
  label: labelOf(beat),
  status,
  at: new Date().toISOString(),
  score: emptyScore(),
  ...over,
});

export function labelOf(b: Beat): string {
  switch (b.kind) {
    case "say":
      return b.checkpoint;
    case "free":
      return b.topic;
    case "line":
      return b.checkpoint;
    case "burst":
      return `burst of ${b.texts.length}`;
    case "topup":
    case "tip":
    case "set_cap":
      return `${b.kind} ${b.cents}`;
    case "unlock":
      return `unlock latest, want ${b.result}`;
    case "nudge":
      return b.what;
    case "human":
      return `human ${b.action}`;
    case "wait":
      return `wait ${b.ms}`;
  }
}

const fail = (beat: number, kind: string, detail: string): SimFailure => ({ beat, kind, detail });

/** say / free / line / burst: the fan writes (or the file fixes the words), the message goes through sendFanMessage, the engine answers in-process, and the turn is scored. */
export async function messageBeat(env: BeatEnv, index: number, beat: Kind<"say" | "free" | "line" | "burst">): Promise<BeatOutcome> {
  const { persona, deps } = env;
  const minor = persona.slug === "minor";
  let conversationId = await conversationOf(env.fanId, env.creatorId);
  const view = await readFanView(env.fanId, conversationId);

  let texts: string[];
  if (beat.kind === "burst") {
    texts = beat.texts;
  } else {
    const fixedText = beat.kind === "say" && beat.fixed ? beat.text : undefined;
    const step = await agentStep(deps, {
      persona,
      variant: env.variant,
      task: beat.kind === "free" ? beat.topic : beat.checkpoint,
      intent: beat.kind === "line" ? beat.intent : undefined,
      fixedText,
      view,
      seed: env.seed,
      decider: deps.engine.decider,
    });
    env.micros += step.micros;
    if (step.kind === "wait") return { result: result(index, beat, "skipped", { note: "agent waited" }) };
    if (step.kind === "leave") return { result: result(index, beat, "skipped", { note: "agent left" }), stop: "agent_left" };
    if (step.kind === "content_blocked") {
      // A blocked line is never sent. For the minor persona it is a persona-file bug and fails the run.
      const r = result(index, beat, "blocked", { note: `content_blocked: ${step.reason}`, score: { ...emptyScore(), failures: minor ? [fail(index, "content_blocked", step.reason)] : [] } });
      return { result: r, ...(minor ? { stop: "content_blocked" } : {}) };
    }
    if (step.kind === "sim_refusal") return { result: result(index, beat, "refused", { note: "sim_refusal" }) };
    texts = [step.text];
  }

  const before = await readBefore(env.fanId, conversationId);
  if (env.mode === "demo") await deps.sleep(Math.round((await getConfig<number>("sim.demo_gap_ms")) * env.variant.jitter));

  // Sends are not awaited one after the other for a burst: they land `sim.burst_gap_ms` apart, then the engine answers once.
  const gap = beat.kind === "burst" ? await getConfig<number>("sim.burst_gap_ms") : 0;
  let refused = false;
  const sends = texts.map(async (text, k) => {
    if (k > 0) await deps.sleep(gap * k);
    try {
      const sent = await sendFanMessage(env.fanId, env.creatorId, text, `${env.runId}:${index}:${k}`, () => {}, async () => understudyFor(deps.engine));
      conversationId = sent.conversationId;
    } catch (e) {
      if (e instanceof SendRefused) refused = true;
      else throw e;
    }
  });
  await Promise.all(sends);
  if (!conversationId) return { result: result(index, beat, "failed", { sent: texts, score: { ...emptyScore(), failures: [fail(index, "send_refused", "no conversation: the first send was refused")] } }), stop: "send_refused" };
  const convId = conversationId;

  const factsCfg = {
    declineWindowMinutes: await getConfig<number>("pitch.decline_window_minutes"),
    velocityWindowMinutes: await getConfig<number>("pitch.velocity_window_minutes"),
    strikeWindowDays: await getConfig<number>("ts.strike_window_days"),
  };
  const facts = refused ? null : await loadFacts({ db, config: dbConfigPort, host: dbHost, deps: deps.engine }, convId, env.fanId, env.creatorId, factsCfg);
  let engineErrorLine: string | null = null;
  if (!refused) {
    const run = await captureEngineErrors(() => understudyFor(deps.engine).processConversation(convId));
    engineErrorLine = run.lines.at(-1) ?? null;
  }

  const { obs, extras } = await observe({
    fanId: env.fanId,
    creatorId: env.creatorId,
    conversationId: convId,
    before,
    threadId: `${env.persona.slug}`,
    turnIndex: index,
    row: beat.row ?? null,
    expect: beat.expect!,
    refused,
    facts,
    engineErrorLine,
  });
  const score = scoreBeat(index, beat, obs, extras);
  const status: BeatResult["status"] = score.failures.length ? "failed" : score.pending.length ? "pending" : "done";
  return { result: result(index, beat, status, { score, sent: texts, ...(refused ? { note: "send refused" } : {}) }) };
}

async function latestOffer(conversationId: string | null, openOnly: boolean) {
  if (!conversationId) return null;
  const [o] = await db
    .select({ id: offers.id, status: offers.status })
    .from(offers)
    .where(and(eq(offers.conversationId, conversationId), openOnly ? eq(offers.status, "open") : undefined))
    .orderBy(desc(offers.createdAt))
    .limit(1);
  return o ?? null;
}

async function assertBalanceEqualsLedger(fanId: string): Promise<SimFailure[] | null> {
  const [w] = await db.select({ b: wallets.balanceCents }).from(wallets).where(eq(wallets.fanId, fanId));
  const sum = await withTx((tx) => ledgerSum(tx, fanId));
  return (w?.b ?? 0) === sum ? null : [fail(-1, "balance_ledger", `balance ${w?.b ?? 0} ledger ${sum}`)];
}

const CODE: Record<string, string> = { InsufficientFunds: "insufficient_funds", CapReached: "cap_reached", OfferUnavailable: "offer_unavailable", NotAllowed: "not_allowed" };

/** Money and clock beats: top-up through Stripe and the webhook, unlock, tip, cap, offer expiry. Wallet code is called as the fan's own action. */
export async function moneyBeat(env: BeatEnv, index: number, beat: Kind<"topup" | "tip" | "set_cap" | "unlock" | "nudge">): Promise<BeatOutcome> {
  const conversationId = await conversationOf(env.fanId, env.creatorId);
  const bad = (b: Beat, ...fs: SimFailure[]) => ({ result: result(index, b, "failed", { score: { ...emptyScore(), failures: fs.map((f) => ({ ...f, beat: index })) } }) });

  switch (beat.kind) {
    case "topup": {
      const r = await env.deps.stripe.topup(env.fanId, beat.cents);
      if (!r.ok) return bad(beat, fail(index, `topup_${r.code}`, `top-up of ${beat.cents} did not credit`));
      const mismatch = await assertBalanceEqualsLedger(env.fanId);
      return mismatch ? bad(beat, ...mismatch) : { result: result(index, beat, "done") };
    }
    case "tip": {
      try {
        // In a chat the tip goes through the fan's own path (system row and her thanks); the engine runs here, not after a response.
        if (conversationId) await tipInChat(env.fanId, env.creatorId, conversationId, beat.cents, `${env.runId}:${index}`, () => {});
        else await tip(env.fanId, env.creatorId, beat.cents, `${env.runId}:${index}`);
      } catch (e) {
        return bad(beat, fail(index, "tip", CODE[(e as Error).name] ?? (e as Error).name));
      }
      if (conversationId) {
        const convId = conversationId;
        await captureEngineErrors(() => understudyFor(env.deps.engine).processConversation(convId));
      }
      const mismatch = await assertBalanceEqualsLedger(env.fanId);
      return mismatch ? bad(beat, ...mismatch) : { result: result(index, beat, "done") };
    }
    case "set_cap": {
      await setFanCap(env.fanId, beat.cents);
      return { result: result(index, beat, "done") };
    }
    case "nudge": {
      // The one clock write: offers are 24h long and a run lasts minutes, so the offer's expiry is brought forward and the sweep's own function runs.
      if (conversationId) {
        await db.update(offers).set({ expiresAt: sql`now() - interval '1 second'` }).where(and(eq(offers.conversationId, conversationId), eq(offers.status, "open")));
      }
      const n = await understudyFor(env.deps.engine).expireOffers();
      return { result: result(index, beat, "done", { note: `clock_nudge: ${n} expired` }) };
    }
    case "unlock": {
      const offer = await latestOffer(conversationId, beat.on_open_offer === true);
      if (!offer) {
        if (beat.optional_if_no_offer || beat.result === "no_offer") return { result: result(index, beat, "skipped", { note: "no offer was open" }) };
        return bad(beat, fail(index, "unlock", "no offer to unlock"));
      }
      let got: string;
      try {
        const r = await unlockInChat(env.fanId, offer.id, () => {});
        got = r.alreadyUnlocked ? "already" : "unlocked";
        // A real purchase gets her check-in, run here rather than after a response.
        if (!r.alreadyUnlocked) await captureEngineErrors(() => understudyFor(env.deps.engine).processConversation(r.conversationId));
      } catch (e) {
        const code = CODE[(e as Error).name];
        if (!code) throw e;
        got = code;
      }
      const failures: SimFailure[] = [];
      if (got !== beat.result) failures.push(fail(index, "unlock", `want ${beat.result} got ${got}`));
      const mismatch = await assertBalanceEqualsLedger(env.fanId);
      if (mismatch) failures.push(...mismatch.map((f) => ({ ...f, beat: index })));
      return { result: result(index, beat, failures.length ? "failed" : "done", { score: { ...emptyScore(), failures }, note: `unlock: ${got}` }) };
    }
  }
}

/** Human beats. Auto mode acts as the seat user; demo mode waits (up to `sim.human_wait_ms`) for the observable ones while a person acts in the console. */
export async function humanBeat(env: BeatEnv, index: number, beat: Kind<"human">, onWaiting: (waiting: boolean) => Promise<void>): Promise<BeatOutcome> {
  const conversationId = await conversationOf(env.fanId, env.creatorId);
  if (!conversationId) return { result: result(index, beat, "failed", { score: { ...emptyScore(), failures: [fail(index, "human", "no conversation yet")] } }) };
  const ctx: HumanCtx = { ...env.humans, conversationId };
  const wait = env.mode === "demo" ? expectedState(ctx, beat) : null;
  if (wait) {
    await onWaiting(true);
    const limit = Date.now() + (await getConfig<number>("sim.human_wait_ms"));
    let met = false;
    while (Date.now() < limit) {
      if (await wait()) {
        met = true;
        break;
      }
      await env.deps.sleep(1000);
    }
    await onWaiting(false);
    env.humans.undo = ctx.undo;
    return met
      ? { result: result(index, beat, "done", { note: "a person did it in the console" }) }
      : { result: result(index, beat, "failed", { score: { ...emptyScore(), failures: [fail(index, "human_timeout", beat.action)] } }), stop: "human_timeout" };
  }
  const r = await humanAct(ctx, beat);
  env.humans.undo = ctx.undo;
  return r.ok
    ? { result: result(index, beat, "done") }
    : { result: result(index, beat, "failed", { score: { ...emptyScore(), failures: [fail(index, "human", r.code)] } }) };
}
