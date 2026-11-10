import { and, asc, count, eq, inArray, notInArray } from "drizzle-orm";
import { db } from "@/db/client";
import { catalogueItems, conversations, fanMemory, handoffs, messages, offers, sessions, turns, users } from "@/db/schema";
import { getConfig } from "@/lib/config";
import type { LoadedFacts } from "@jadd0/understudy-engine/internal";
import { writesBoundaryLine, type Observation } from "@/lib/evals/score";
import type { Expect, MatrixRow } from "@/lib/evals/threads";

const TS_MODES = new Set(["handoff_ts", "human_ts"]);
const CREATOR_MODES = new Set(["handoff_creator", "human_creator"]);

/** What the sim reads beside 9b's observation. */
export interface SimExtras {
  flagged: boolean;
  flagReason: string | null;
  sessions: number;
  inboundCount: number;
  attempts: number;
  mode: string | null;
  sendRefused: boolean;
  /** Platform messages (sender "system") sent during the beat. */
  notices: string[];
  /** Offered catalogue kinds this beat. */
  offerKinds: string[];
  /** The fan_memory profile as text. */
  memory: string;
  noPitchActive: boolean;
  /** The inbound Jev call's intent and the safety keys at or over their floors, for checkpoint matching. */
  jevIntent: string | null;
  jevSafety: string[];
  engineErrorLine: string | null;
}

/** State read before a beat's messages are sent, so the observation can tell what the beat changed. */
export interface Before {
  seenTurns: string[];
  seenMessages: string[];
  hardStoppedBefore: boolean;
}

export async function readBefore(fanId: string, conversationId: string | null): Promise<Before> {
  const [fan] = await db.select({ at: users.flaggedAt }).from(users).where(eq(users.id, fanId));
  if (!conversationId) return { seenTurns: [], seenMessages: [], hardStoppedBefore: Boolean(fan?.at) };
  const [conv] = await db.select({ mode: conversations.mode }).from(conversations).where(eq(conversations.id, conversationId));
  const seenTurns = (await db.select({ id: turns.id }).from(turns).where(eq(turns.conversationId, conversationId))).map((t) => t.id);
  const seenMessages = (await db.select({ id: messages.id }).from(messages).where(eq(messages.conversationId, conversationId))).map((m) => m.id);
  return { seenTurns, seenMessages, hardStoppedBefore: Boolean(fan?.at) || TS_MODES.has(conv.mode) };
}

export interface ObserveInput {
  fanId: string;
  creatorId: string;
  conversationId: string;
  before: Before;
  threadId: string;
  turnIndex: number;
  row: MatrixRow | null;
  expect: Expect;
  /** The beat's sends were refused (a flagged or restricted fan). */
  refused: boolean;
  /** Pacing facts read just before the engine ran. */
  facts: LoadedFacts | null;
  /** The last `engine:` error line captured while the engine ran. */
  engineErrorLine: string | null;
}

/**
 * Reads the rows one beat produced into 9b's Observation plus the sim extras. This is the same reading the eval
 * runner does (lib/evals/runner.ts keeps its copy inline), kept here because the runner does not export it.
 */
export async function observe(i: ObserveInput): Promise<{ obs: Observation; extras: SimExtras }> {
  const { conversationId: convId, before } = i;
  const floorHardship = await getConfig<number>("floor.safety.hardship");
  const fresh = await db
    .select()
    .from(turns)
    .where(before.seenTurns.length ? and(eq(turns.conversationId, convId), notInArray(turns.id, before.seenTurns)) : eq(turns.conversationId, convId))
    .orderBy(asc(turns.createdAt), asc(turns.id));
  const [conv] = await db.select({ mode: conversations.mode }).from(conversations).where(eq(conversations.id, convId));
  const [fan] = await db.select({ flaggedAt: users.flaggedAt, reason: users.flagReason }).from(users).where(eq(users.id, i.fanId));
  const [sess] = await db.select({ n: count() }).from(sessions).where(eq(sessions.userId, i.fanId));
  const queue: Observation["queue"] = TS_MODES.has(conv.mode) ? "ts" : CREATOR_MODES.has(conv.mode) ? "creator" : "none";
  const [alertRow] = await db
    .select({ id: handoffs.id })
    .from(handoffs)
    .where(and(eq(handoffs.conversationId, convId), eq(handoffs.reason, "high_value_alert")))
    .limit(1);
  const [mem] = await db.select({ profile: fanMemory.profile }).from(fanMemory).where(and(eq(fanMemory.fanId, i.fanId), eq(fanMemory.creatorId, i.creatorId)));

  const newSystem = await db
    .select({ body: messages.body })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, convId),
        eq(messages.sender, "system"),
        eq(messages.status, "sent"),
        before.seenMessages.length ? notInArray(messages.id, before.seenMessages) : undefined,
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id));

  const base = { threadId: i.threadId, turnIndex: i.turnIndex, row: i.row, expect: i.expect };
  const noFacts = { noPitchActive: i.facts?.noPitchActive ?? false, atCap: i.facts?.atCap ?? false, hardshipFired: false };
  const extrasBase = {
    flagged: Boolean(fan?.flaggedAt),
    flagReason: fan?.reason ?? null,
    sessions: sess.n,
    mode: conv.mode as string | null,
    sendRefused: i.refused,
    notices: newSystem.map((m) => m.body),
    memory: JSON.stringify(mem?.profile ?? {}),
    noPitchActive: i.facts?.noPitchActive ?? false,
    engineErrorLine: i.engineErrorLine,
  };

  if (fresh.length === 0) {
    const humanOwns = conv.mode !== "ai";
    const errored = !(i.expect.silent || i.refused || humanOwns);
    const obs: Observation = {
      ...base,
      outcome: errored ? "error" : "silent",
      route: null,
      queue,
      alert: Boolean(alertRow),
      hardStoppedBefore: before.hardStoppedBefore,
      replies: [],
      offerMade: false,
      pitchForbidden: noFacts,
      verify: { explicit: null, admitsAi: null },
      turnsRun: 0,
      msTotal: null,
      costMicros: 0,
      ...(errored ? { errorCode: i.engineErrorLine ?? "no_turn" } : {}),
    };
    return { obs, extras: { ...extrasBase, inboundCount: 0, attempts: 0, offerKinds: [], jevIntent: null, jevSafety: [] } };
  }

  const last = fresh.at(-1)!;
  const failed = fresh.some((t) => t.outcome === "error");
  const ids = fresh.map((t) => t.id);
  const replyRows = await db
    .select({ body: messages.body })
    .from(messages)
    .where(and(inArray(messages.turnId, ids), eq(messages.sender, "ai"), eq(messages.status, "sent"), eq(messages.suggested, false)))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  const fixedReply = fresh.some((t) => t.route === "hard_stop" && !writesBoundaryLine(t.jevOut));
  const trail = Array.isArray(last.jevOut) ? (last.jevOut as { answers?: Record<string, string> | null }[]) : [];
  const answers = trail.at(-1)?.answers ?? null;
  const first = fresh[0];
  const jev = first.jevIn as { parsed?: { intent?: string; p?: Record<string, number> }; answers?: Record<string, string> } | null;
  const lastJev = last.jevIn as { parsed?: { p?: Record<string, number> } } | null;
  const offerIds = fresh.flatMap((t) => (t.offerId ? [t.offerId] : []));
  const offerKinds = offerIds.length
    ? (await db.select({ kind: catalogueItems.kind }).from(offers).innerJoin(catalogueItems, eq(catalogueItems.id, offers.itemId)).where(inArray(offers.id, offerIds))).map((r) => r.kind)
    : [];

  const jevSafety: string[] = [];
  for (const [k, p] of Object.entries(jev?.parsed?.p ?? {})) {
    const floor = await getConfig<number>(`floor.safety.${k}`).catch(() => 1);
    if (p >= floor) jevSafety.push(k);
  }

  const obs: Observation = {
    ...base,
    outcome: failed ? "error" : "answered",
    route: last.route ?? null,
    queue,
    alert: Boolean(alertRow),
    hardStoppedBefore: before.hardStoppedBefore,
    replies: replyRows.map((r) => ({ body: r.body, template: fixedReply })),
    offerMade: fresh.some((t) => t.offerId !== null),
    pitchForbidden: { ...noFacts, hardshipFired: (lastJev?.parsed?.p?.hardship ?? 0) >= floorHardship },
    verify: { explicit: answers ? answers.explicitness === "explicit" : null, admitsAi: answers ? answers.admits_ai === "yes" : null },
    turnsRun: fresh.filter((t) => t.outcome !== "error").length,
    msTotal: last.msTotal,
    costMicros: fresh.reduce((s, t) => s + (t.costMicros ?? 0), 0),
    ...(failed ? { errorCode: i.engineErrorLine ?? "engine_error" } : {}),
  };
  return {
    obs,
    extras: {
      ...extrasBase,
      inboundCount: fresh.reduce((s, t) => s + t.inboundIds.length, 0),
      attempts: Math.max(...fresh.map((t) => t.attempts ?? 0)),
      offerKinds,
      jevIntent: jev?.parsed?.intent ?? null,
      jevSafety,
    },
  };
}
