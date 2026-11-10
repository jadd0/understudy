import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db/client";
import { conversations, messages, personaCards, users } from "@/db/schema";
import { ban, handBackConversation, releaseConversation, sendAsCreator, sendSuggested, setConversationAi, setGlobalAi, setNeverList, takeOverConversation } from "@/lib/conversations/controls";
import type { Viewer } from "@/lib/conversations/read";
import { understudy } from "@/lib/host/deps";
import type { Events } from "@jadd0/understudy-engine";
import type { Beat } from "./persona";

type HumanBeat = Extract<Beat, { kind: "human" }>;

/** The two demo seats a human beat acts as: Juno (creator) and the Trust & Safety admin. */
export interface Seats {
  creator: Viewer | null;
  admin: Viewer | null;
}

const norm = (e: string) => e.trim().toLowerCase();

/** Resolves `SEED_CREATOR_EMAIL` and the first of `SEED_ADMIN_EMAILS` to their user rows. A missing seat is null; the beat then fails with `seat_missing`. */
export async function loadSeats(env: NodeJS.ProcessEnv = process.env): Promise<Seats> {
  const find = async (email: string | undefined, role: "creator" | "admin"): Promise<Viewer | null> => {
    if (!email) return null;
    const [u] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.email, norm(email)));
    return u && u.role === role ? { id: u.id, role } : null;
  };
  return {
    creator: await find(env.SEED_CREATOR_EMAIL, "creator"),
    admin: await find((env.SEED_ADMIN_EMAILS ?? "").split(",")[0], "admin"),
  };
}

export interface UndoRecord {
  label: "ai_off" | "global_ai_off" | "never_list";
  /** The never-list before the run changed it. */
  previous?: string[];
  /** The AI switch's value before the run changed it (ai_off, global_ai_off); undo puts back this value, not "on". */
  priorOn?: boolean;
}

export interface HumanCtx {
  conversationId: string;
  fanId: string;
  creatorId: string;
  seats: Seats;
  events: Events;
  /** Things the run changed that it puts back at the end, newest last. Kept as data so a run that spans several ticks (or a crash) can still restore them. */
  undo: UndoRecord[];
  /** Writes the undo list to the run row. Called after a record is added and before the change it describes, so a crash between the two cannot lose it. */
  persist?: (undo: UndoRecord[]) => Promise<void>;
}

/** The creator's AI switch, read through the engine. */
const creatorAiOn = async (creatorId: string) => (await understudy()).creatorAi(creatorId);

export type HumanResult = { ok: true } | { ok: false; code: string };

const SEAT_FOR: Record<HumanBeat["action"], "creator" | "admin"> = {
  takeover: "creator", send: "creator", hand_back: "creator", ai_off: "creator", ai_on: "creator", global_ai_off: "creator",
  global_ai_on: "creator", set_never_list: "creator", restore_never_list: "creator", send_suggested: "creator", release: "admin", ban: "admin",
};

async function liveCardNeverList(creatorId: string): Promise<string[]> {
  const [card] = await db
    .select({ neverList: personaCards.neverList })
    .from(personaCards)
    .where(and(eq(personaCards.creatorId, creatorId), isNotNull(personaCards.publishedAt)))
    .orderBy(desc(personaCards.version))
    .limit(1);
  return card?.neverList ?? [];
}

/** Performs one human beat as the seat user that would do it, through lib/conversations/controls.ts, so the permission checks run. */
export async function humanAct(ctx: HumanCtx, beat: HumanBeat): Promise<HumanResult> {
  const viewer = ctx.seats[SEAT_FOR[beat.action]];
  if (!viewer) return { ok: false, code: "seat_missing" };
  const { conversationId: convId, events } = ctx;
  try {
    switch (beat.action) {
      case "takeover":
        await takeOverConversation(viewer, convId, events);
        break;
      case "send":
        await sendAsCreator(viewer, convId, beat.text ?? "hi", events);
        break;
      case "hand_back":
        await handBackConversation(viewer, convId, events);
        break;
      case "ai_off": {
        const [c] = await db.select({ on: conversations.aiEnabled }).from(conversations).where(eq(conversations.id, convId));
        ctx.undo.push({ label: "ai_off", priorOn: c?.on ?? true });
        await ctx.persist?.(ctx.undo);
        await setConversationAi(viewer, convId, false);
        break;
      }
      case "ai_on":
        // The record stays: the end of the run puts back the value the run found, which may not be "on".
        await setConversationAi(viewer, convId, true);
        break;
      case "global_ai_off": {
        ctx.undo.push({ label: "global_ai_off", priorOn: await creatorAiOn(ctx.creatorId) });
        await ctx.persist?.(ctx.undo);
        await setGlobalAi(viewer, false);
        break;
      }
      case "global_ai_on":
        await setGlobalAi(viewer, true);
        break;
      case "set_never_list": {
        ctx.undo.push({ label: "never_list", previous: await liveCardNeverList(ctx.creatorId) });
        await ctx.persist?.(ctx.undo);
        await setNeverList(viewer, beat.terms ?? []);
        break;
      }
      case "restore_never_list": {
        const at = ctx.undo.map((u) => u.label).lastIndexOf("never_list");
        if (at >= 0) {
          await setNeverList(viewer, ctx.undo[at].previous ?? []);
          ctx.undo.splice(at, 1);
          await ctx.persist?.(ctx.undo);
        }
        break;
      }
      case "send_suggested": {
        const [m] = await db
          .select({ id: messages.id, body: messages.body })
          .from(messages)
          .where(and(eq(messages.conversationId, convId), eq(messages.suggested, true), eq(messages.sender, "ai")))
          .orderBy(desc(messages.createdAt))
          .limit(1);
        if (!m) return beat.optional ? { ok: true } : { ok: false, code: "no_suggested" };
        await sendSuggested(viewer, m.id, m.body, events);
        break;
      }
      case "release":
        // By conversation, not handoff id: an admin who took the chat over from the AI has no handoff to release.
        await releaseConversation(viewer, convId, events);
        break;
      case "ban":
        await ban(viewer, ctx.fanId);
        break;
    }
  } catch (e) {
    return { ok: false, code: (e as { code?: string }).code ?? (e as Error).name };
  }
  return { ok: true };
}

/**
 * Puts back what the run changed (switches to the value they had, the never-list), newest first. A record whose
 * restore fails stays in `ctx.undo` so a later attempt can retry it; the errors are returned, never thrown.
 */
export async function undoAll(ctx: HumanCtx): Promise<string[]> {
  const errors: string[] = [];
  const failed: UndoRecord[] = [];
  const viewer = ctx.seats.creator;
  while (ctx.undo.length) {
    const u = ctx.undo.pop()!;
    try {
      if (!viewer) throw new Error("seat_missing");
      if (u.label === "ai_off") await setConversationAi(viewer, ctx.conversationId, u.priorOn ?? true);
      else if (u.label === "global_ai_off") await setGlobalAi(viewer, u.priorOn ?? true);
      else await setNeverList(viewer, u.previous ?? []);
    } catch (e) {
      errors.push(`${u.label}:${(e as Error).name}`);
      failed.unshift(u);
    }
  }
  ctx.undo = failed;
  return errors;
}

/** The state a human beat leaves behind, for demo mode to wait on while a person acts in the console. Null: not observable, so the sim performs it. */
export function expectedState(ctx: Pick<HumanCtx, "conversationId" | "fanId" | "creatorId">, beat: HumanBeat): (() => Promise<boolean>) | null {
  const convMode = async () => (await db.select({ mode: conversations.mode, ai: conversations.aiEnabled }).from(conversations).where(eq(conversations.id, ctx.conversationId)))[0];
  switch (beat.action) {
    case "takeover":
      return async () => (await convMode())?.mode === "human_creator";
    case "hand_back":
    case "release":
      return async () => (await convMode())?.mode === "ai";
    case "ban":
      return async () => Boolean((await db.select({ f: users.flaggedAt }).from(users).where(eq(users.id, ctx.fanId)))[0]?.f);
    case "ai_off":
      return async () => (await convMode())?.ai === false;
    case "ai_on":
      return async () => (await convMode())?.ai === true;
    case "global_ai_off":
      return async () => (await creatorAiOn(ctx.creatorId)) === false;
    case "global_ai_on":
      return async () => (await creatorAiOn(ctx.creatorId)) === true;
    default:
      return null;
  }
}
