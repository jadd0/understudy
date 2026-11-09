import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db, withTx } from "@/db/client";
import { catalogueItems, conversations, handoffs, messages, offers, turns, users } from "@/db/schema";
import { sendFanMessage, SendRefused } from "@/lib/chat/send";
import { getConfig } from "@/lib/config";
import { type Deps, loadFacts, processConversation } from "@understudy/engine";
import { credit, debit } from "@/lib/wallet/ledger";
import { setFanCap } from "@/lib/wallet/cap";
import type { Observation } from "./score";
import type { Setup, Thread } from "./threads";

/** The runner writes fans, wallets and conversations; it only ever does so in a database built for it. */
export function assertEvalDatabase(url = process.env.DATABASE_URL ?? ""): string {
  const name = url ? new URL(url).pathname.replace(/^\//, "") : "";
  if (!/_eval$/.test(name) && !name.includes("_test_")) {
    throw new Error(`eval runner refuses database "${name}": it must end in _eval or be a per-branch test database`);
  }
  return name;
}

export interface RunnerContext {
  deps: Deps;
  creatorId: string;
  /** Distinguishes this run's fans from earlier runs in the same database. */
  runTag: string;
}

/** Class and code of an engine failure line; the engine logs these two words and never a message. */
const ENGINE_LINE = /^engine: (.+)$/;

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

/** Builds the fan's starting state through the wallet's own primitives, so the ledger and balance agree. */
export async function applySetup(fanId: string, creatorId: string, setup: Setup | undefined): Promise<void> {
  if (!setup) return;
  const platformCap = await getConfig<number>("wallet.daily_cap_cents");
  const spend: { kind: "unlock" | "tip"; cents: number }[] = [];
  for (let i = 0; i < (setup.recent_unlocks ?? 0); i++) spend.push({ kind: "unlock", cents: 100 });
  if (setup.high_value) spend.push({ kind: "unlock", cents: await getConfig<number>("fan.high_value_threshold_cents", creatorId) });
  if (setup.at_cap) spend.push({ kind: "tip", cents: 500 });

  const total = (setup.wallet_cents ?? 0) + spend.reduce((s, x) => s + x.cents, 0);
  if (total > 0) await withTx((tx) => credit(tx, { fanId, kind: "topup", amountCents: total, stripeEventId: `evt_eval_${randomUUID()}` }));
  for (const s of spend) {
    await withTx((tx) => debit(tx, { fanId, creatorId, kind: s.kind, amountCents: s.cents, platformCapCents: platformCap }));
  }
  // The cap equals what he already spent today, so the next pitch is past it.
  if (setup.at_cap) await setFanCap(fanId, 500);
}

async function makeEvalFan(thread: Thread, runTag: string) {
  const [fan] = await db
    .insert(users)
    .values({
      email: `eval+${runTag}-${thread.id}@understudy.test`,
      name: `eval ${thread.id}`,
      role: "fan",
      adultConfirmedAt: new Date("2026-01-01T00:00:00Z"),
      isSim: true,
    })
    .returning();
  return fan;
}

/**
 * Earlier chat, stamped with a stand-in turn (outcome 'seed') so none of it is waiting for an answer and the
 * engine's own turns are the only ones the thread counts.
 */
export async function seedHistory(fanId: string, creatorId: string, history: NonNullable<Setup["history"]>): Promise<string> {
  await db.insert(conversations).values({ creatorId, fanId }).onConflictDoNothing();
  const [conv] = await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.creatorId, creatorId), eq(conversations.fanId, fanId)));
  const [seedTurn] = await db.insert(turns).values({ conversationId: conv.id, outcome: "seed" }).returning({ id: turns.id });
  // Oldest first in the file; a small offset keeps lines with the same minutes_ago in file order.
  for (const [i, line] of history.entries()) {
    await db.insert(messages).values({
      conversationId: conv.id,
      sender: line.from === "fan" ? "fan" : "ai",
      senderUserId: line.from === "fan" ? fanId : null,
      body: line.text,
      status: "sent",
      turnId: seedTurn.id,
      createdAt: sql`now() - make_interval(secs => ${line.minutes_ago * 60 - i * 0.001})` as unknown as Date,
    });
  }
  return conv.id;
}

/** Moves everything the conversation holds into the past, so the next message follows a gap. */
export async function ageConversation(conversationId: string, minutes: number): Promise<void> {
  const secs = minutes * 60;
  await db.execute(sql`update messages set created_at = created_at - make_interval(secs => ${secs}) where conversation_id = ${conversationId}`);
  await db.execute(sql`update turns set created_at = created_at - make_interval(secs => ${secs}) where conversation_id = ${conversationId}`);
  await db.execute(sql`update offers set created_at = created_at - make_interval(secs => ${secs}) where conversation_id = ${conversationId}`);
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const TS_MODES = new Set(["handoff_ts", "human_ts"]);
const CREATOR_MODES = new Set(["handoff_creator", "human_creator"]);

/** Plays one thread in a fresh conversation, a turn at a time, and returns what each turn did. */
export async function runThread(thread: Thread, ctx: RunnerContext): Promise<Observation[]> {
  assertEvalDatabase();
  const fan = await makeEvalFan(thread, ctx.runTag);
  await applySetup(fan.id, ctx.creatorId, thread.setup);
  const floorHardship = await getConfig<number>("floor.safety.hardship");
  const factsCfg = {
    declineWindowMinutes: await getConfig<number>("pitch.decline_window_minutes"),
    velocityWindowMinutes: await getConfig<number>("pitch.velocity_window_minutes"),
  };

  const out: Observation[] = [];
  let conversationId: string | null = thread.setup?.history ? await seedHistory(fan.id, ctx.creatorId, thread.setup.history) : null;

  for (const [turnIndex, turn] of thread.turns.entries()) {
    const base = { threadId: thread.id, turnIndex, row: turn.row ?? null, expect: turn.expect };

    const [flagged] = await db.select({ at: users.flaggedAt }).from(users).where(eq(users.id, fan.id));
    let modeBefore: string | null = null;
    if (conversationId) {
      const [c] = await db.select({ mode: conversations.mode }).from(conversations).where(eq(conversations.id, conversationId));
      modeBefore = c.mode;
    }
    const hardStoppedBefore = Boolean(flagged?.at) || (modeBefore !== null && TS_MODES.has(modeBefore));

    const seenTurns = conversationId ? (await db.select({ id: turns.id }).from(turns).where(eq(turns.conversationId, conversationId))).map((t) => t.id) : [];

    if (turn.after_minutes && conversationId) await ageConversation(conversationId, turn.after_minutes);

    // The send stores the message; this run answers it, so the scheduler is a no-op and the deps are the run's own.
    let refused = false;
    for (const [k, text] of turn.say.entries()) {
      try {
        const sent = await sendFanMessage(fan.id, ctx.creatorId, text, `${ctx.runTag}:${thread.id}:${turnIndex}:${k}`, () => {});
        conversationId = sent.conversationId;
      } catch (e) {
        if (e instanceof SendRefused) refused = true;
        else throw e;
      }
    }

    const silentOutcome = (): Observation => ({
      ...base,
      outcome: "silent",
      route: null,
      queue: "none",
      alert: false,
      hardStoppedBefore,
      replies: [],
      offerMade: false,
      pitchForbidden: { noPitchActive: false, atCap: false, hardshipFired: false },
      verify: { explicit: null, admitsAi: null },
      turnsRun: 0,
      msTotal: null,
      costMicros: 0,
    });

    if (!conversationId) throw new Error(`thread ${thread.id}: first message was refused (${refused ? "send refused" : "no conversation"})`);
    const convId = conversationId;

    const facts = refused ? null : await loadFacts(convId, fan.id, ctx.creatorId, factsCfg, ctx.deps.host);
    let errorLines: string[] = [];
    if (!refused) {
      // Messages scheduled with say_later arrive while the engine is working, the way a fan types on.
      const later = (turn.say_later ?? []).map(async (l, k) => {
        await wait(l.after_ms);
        await sendFanMessage(fan.id, ctx.creatorId, l.text, `${ctx.runTag}:${thread.id}:${turnIndex}:later${k}`, () => {});
      });
      const run = await captureEngineErrors(async () => {
        const [answered] = await Promise.all([processConversation(convId, ctx.deps), ...later]);
        // One that landed after the turn finished is answered by the next turn, as the live trigger would.
        return answered + (later.length > 0 ? await processConversation(convId, ctx.deps) : 0);
      });
      errorLines = run.lines;
    }

    const fresh = await db
      .select()
      .from(turns)
      .where(seenTurns.length ? and(eq(turns.conversationId, convId), notInArray(turns.id, seenTurns)) : eq(turns.conversationId, convId))
      .orderBy(asc(turns.createdAt), asc(turns.id));
    const [conv] = await db.select({ mode: conversations.mode }).from(conversations).where(eq(conversations.id, convId));
    const queue: Observation["queue"] = TS_MODES.has(conv.mode) ? "ts" : CREATOR_MODES.has(conv.mode) ? "creator" : "none";
    const [alertRow] = await db
      .select({ id: handoffs.id })
      .from(handoffs)
      .where(and(eq(handoffs.conversationId, convId), eq(handoffs.reason, "high_value_alert")))
      .limit(1);

    if (fresh.length === 0) {
      const o = silentOutcome();
      o.queue = queue;
      o.alert = Boolean(alertRow);
      // Nothing ran. That is right when a human or T&S owns the conversation (the thread's own expectations then report a
      // miss), and an error only when the AI still owned it and a reply was due.
      const humanOwns = conv.mode !== "ai";
      out.push(turn.expect.silent || refused || humanOwns ? o : { ...o, outcome: "error", errorCode: errorLines.at(-1) ?? "no_turn" });
      continue;
    }

    const last = fresh.at(-1)!;
    const failed = fresh.some((t) => t.outcome === "error");
    const ids = fresh.map((t) => t.id);
    const replyRows = await db
      .select({ body: messages.body })
      .from(messages)
      .where(and(inArray(messages.turnId, ids), eq(messages.sender, "ai"), eq(messages.status, "sent"), eq(messages.suggested, false)))
      .orderBy(asc(messages.createdAt), asc(messages.id));
    const fixedReply = fresh.some((t) => t.route === "hard_stop");

    const offerKinds = ids.length
      ? (
          await db
            .select({ kind: catalogueItems.kind })
            .from(offers)
            .innerJoin(catalogueItems, eq(catalogueItems.id, offers.itemId))
            .innerJoin(turns, eq(turns.offerId, offers.id))
            .where(inArray(turns.id, ids))
        ).map((r) => r.kind)
      : [];
    const reasks = fresh.reduce(
      (acc, t) => {
        const entries = (Array.isArray(t.jevOut) ? t.jevOut : []) as { failures?: string[]; folded?: boolean }[];
        const attempts = entries.filter((e) => Array.isArray(e.failures));
        const fired = attempts.filter((e) => e.failures!.includes("reasks")).length;
        const lastFails = attempts.at(-1)?.failures ?? [];
        return { fired: acc.fired + fired, sentAnyway: acc.sentAnyway + (t.outcome === "replied" && lastFails.length === 1 && lastFails[0] === "reasks" ? 1 : 0) };
      },
      { fired: 0, sentAnyway: 0 },
    );
    const threadAnswer = (last.jevIn as { parsed?: { thread?: string } } | null)?.parsed?.thread ?? null;

    const trail = Array.isArray(last.jevOut) ? (last.jevOut as { answers?: Record<string, string> | null }[]) : [];
    const answers = trail.at(-1)?.answers ?? null;
    const parsed = (last.jevIn as { parsed?: { p?: Record<string, number> } } | null)?.parsed;

    out.push({
      ...base,
      outcome: failed ? "error" : "answered",
      route: last.route ?? null,
      queue,
      alert: Boolean(alertRow),
      hardStoppedBefore,
      replies: replyRows.map((r) => ({ body: r.body, template: fixedReply })),
      offerMade: fresh.some((t) => t.offerId !== null),
      pitchForbidden: {
        noPitchActive: facts?.noPitchActive ?? false,
        atCap: facts?.atCap ?? false,
        hardshipFired: (parsed?.p?.hardship ?? 0) >= floorHardship,
      },
      verify: { explicit: answers ? answers.explicitness === "explicit" : null, admitsAi: answers ? answers.admits_ai === "yes" : null },
      turnsRun: fresh.filter((t) => t.outcome !== "error").length,
      msTotal: last.msTotal,
      costMicros: fresh.reduce((s, t) => s + (t.costMicros ?? 0), 0),
      thread: threadAnswer,
      offerKinds,
      reasks,
      ...(failed ? { errorCode: errorLines.at(-1) ?? "engine_error" } : {}),
    });
  }
  return out;
}

/** Plays every thread in order. A thread that throws outside the engine is recorded as one errored turn, never skipped. */
export async function runThreads(list: Thread[], ctx: RunnerContext, onThread?: (id: string, obs: Observation[]) => void): Promise<Observation[]> {
  const all: Observation[] = [];
  for (const thread of list) {
    let obs: Observation[];
    try {
      obs = await runThread(thread, ctx);
    } catch (e) {
      const err = e as { name?: string; code?: string };
      obs = thread.turns.map((turn, turnIndex) => ({
        threadId: thread.id,
        turnIndex,
        row: turn.row ?? null,
        expect: turn.expect,
        outcome: "error" as const,
        route: null,
        queue: "none" as const,
        alert: false,
        hardStoppedBefore: false,
        replies: [],
        offerMade: false,
        pitchForbidden: { noPitchActive: false, atCap: false, hardshipFired: false },
        verify: { explicit: null, admitsAi: null },
        turnsRun: 0,
        msTotal: null,
        costMicros: 0,
        errorCode: [err?.name ?? "Error", err?.code].filter(Boolean).join(" "),
      }));
    }
    all.push(...obs);
    onThread?.(thread.id, obs);
  }
  return all;
}
