import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { conversations, messages, offers, wallets } from "@/db/schema";
import { getConfig } from "@/lib/config";
import type { Decider } from "@/platform/ports/decider";
import type { GenerateUsage } from "@/platform/ports/generator";
import { simCallMicros } from "./cost";
import type { SimDeps } from "./deps";
import { guard } from "./guard";
import { briefFor, type Persona } from "./persona";
import { buildSimInput, parseAction, retrievalQuery, type FanViewMessage } from "./prompt";
import type { Variant } from "./random";
import { similarLines } from "./retrieve";

/** The chat as the fan sees it: delivered messages only, her held drafts and unsent bubbles excluded, no prices. */
export interface FanView {
  history: FanViewMessage[];
  lastJuno: string;
  openOfferId: string | null;
  balanceCents: number;
}

export async function readFanView(fanId: string, conversationId: string | null): Promise<FanView> {
  const [w] = await db.select({ b: wallets.balanceCents }).from(wallets).where(eq(wallets.fanId, fanId));
  if (!conversationId) return { history: [], lastJuno: "", openOfferId: null, balanceCents: w?.b ?? 0 };
  const rows = await db
    .select({ sender: messages.sender, body: messages.body, offerId: messages.offerId })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.status, "sent"),
        eq(messages.suggested, false),
        or(isNull(messages.deliverAt), lte(messages.deliverAt, sql`now()`)),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id));
  const [open] = await db
    .select({ id: offers.id })
    .from(offers)
    .where(and(eq(offers.conversationId, conversationId), eq(offers.status, "open"), sql`${offers.expiresAt} > now()`))
    .limit(1);
  const history: FanViewMessage[] = rows.map((r) => ({
    from: r.sender === "fan" ? "me" : "juno",
    // The locked card's price is not for the sim to read (it never sees prices or the catalogue).
    body: r.offerId ? "[she sent you a locked item you can unlock]" : r.body,
  }));
  const lastJuno = [...history].reverse().find((m) => m.from === "juno")?.body ?? "";
  return { history: history.slice(-20), lastJuno, openOfferId: open?.id ?? null, balanceCents: w?.b ?? 0 };
}

export type StepResult =
  | { kind: "send"; text: string; micros: number; attempts: number }
  | { kind: "wait"; micros: number }
  | { kind: "leave"; micros: number }
  | { kind: "content_blocked"; reason: string; text: string; micros: number }
  | { kind: "sim_refusal"; micros: number };

export interface StepArgs {
  persona: Persona;
  variant: Variant;
  /** The beat in words: a checkpoint, a topic, or the intent of a library line. */
  task: string;
  /** The library intent to prefer when the model call falls back to a tag sample. */
  intent?: string;
  /** Fixed text: no model, only the guard. */
  fixedText?: string;
  view: FanView;
  seed: string;
  decider: Decider | null;
}

/**
 * One decision of the sim fan: read the chat, pull four of its own example lines, ask Claude (Haiku, `sim.model`) for
 * one JSON action, run the line through the guard, and return it. A guard block or a refusal retries once with the
 * reason as a steer; a second failure is returned as `content_blocked` or `sim_refusal` for the run to log and skip.
 */
export async function agentStep(deps: SimDeps, a: StepArgs): Promise<StepResult> {
  const minor = a.persona.slug === "minor";
  if (a.fixedText !== undefined) {
    const g = await guard(a.fixedText, { minor, decider: a.decider });
    return g.ok ? { kind: "send", text: a.fixedText, micros: 0, attempts: 0 } : { kind: "content_blocked", reason: g.reason, text: a.fixedText, micros: 0 };
  }
  if (minor) throw new Error("the minor persona never calls a model");

  const [model, maxTokens] = await Promise.all([getConfig<string>("sim.model"), getConfig<number>("sim.max_tokens")]);
  const examples = (await similarLines(a.persona.slug, retrievalQuery(a.view.lastJuno, a.task), 4, { embedQuery: deps.embedQuery, seed: a.seed }, a.intent)).map((l) => l.text);

  let micros = 0;
  let hint: string | undefined;
  let blocked: { reason: string; text: string } | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let text: string;
    let usage: GenerateUsage;
    let refusal: boolean;
    try {
      const res = await deps.generator.generate(
        buildSimInput({ briefText: briefFor(a.persona, a.variant.name), name: a.variant.name, age: a.variant.age, city: a.variant.city, task: a.task, hint, history: a.view.history, examples, model, maxTokens }),
      );
      ({ text, usage } = res);
      refusal = res.stopReason === "refusal";
    } catch (e) {
      // Class and code only; an error body can echo the prompt.
      throw Object.assign(new Error(`sim model call failed: ${(e as { code?: string }).code ?? (e as Error).name}`), { simCode: (e as { code?: string }).code ?? "model_error", micros });
    }
    micros += await simCallMicros(model, usage);
    const action = refusal ? null : parseAction(text);
    if (!action) {
      hint = "Your last answer was empty, not the JSON object, or not in character. Reply with the JSON object only, typing as the fan, and keep the message short and harmless.";
      continue;
    }
    if (action.action !== "send_message") return { kind: action.action, micros };
    const g = await guard(action.text, { minor: false, decider: a.decider });
    if (g.ok) return { kind: "send", text: action.text, micros, attempts: attempt };
    blocked = { reason: g.reason, text: action.text };
    hint = `Your last message was blocked (${g.reason}). Write it again in a milder, vaguer way.`;
  }
  return blocked ? { kind: "content_blocked", reason: blocked.reason, text: blocked.text, micros } : { kind: "sim_refusal", micros };
}

/** Looks up the run's conversation (null before the first message). */
export async function conversationOf(fanId: string, creatorId: string): Promise<string | null> {
  const [c] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.fanId, fanId), eq(conversations.creatorId, creatorId)));
  return c?.id ?? null;
}
