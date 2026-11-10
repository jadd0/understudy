import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db, withTx } from "@/db/client";
import { catalogueItems, catalogueKindEnum, conversations, creators, handoffs, messages, offers, personaCards, sessions, users } from "@/db/schema";
import { getConfig } from "@/lib/config";
import { chatter, chatterWithEvents } from "@/lib/host/deps";
import type { Events } from "@understudy/engine";
import { defaultEvents } from "@/providers/pusher/events";
import { InvalidAmount } from "@/lib/wallet/errors";
import { handBack, humanActorOf, takeover, TakeoverRefused } from "./actions";
import { assertVisible, catalogueOrder, consoleCreatorFor, ConversationNotFound, creatorFor, type Viewer } from "./read";

/** The viewer's role does not allow this action on this row. Pages answer it with a 404. */
export class Forbidden extends Error {
  constructor() {
    super("forbidden");
    this.name = "Forbidden";
  }
}

/** The creator already has an open, unexpired offer for this item in this conversation. */
export class OfferAlreadyOpen extends Error {
  constructor() {
    super("offer already open");
    this.name = "OfferAlreadyOpen";
  }
}

export class InvalidInput extends Error {
  constructor(public readonly field: string) {
    super(`invalid ${field}`);
    this.name = "InvalidInput";
  }
}

export const MAX_BODY_CHARS = 2000;
/** The line that sits above a creator's offer card, so the bubble is never empty. */
export const CREATOR_OFFER_BODY = "Here's something for you.";
export const MAX_NEVER_TERMS = 100;
export const MAX_NEVER_TERM_CHARS = 80;
export const MAX_ITEM_TITLE_CHARS = 80;
export const MAX_ITEM_TEASER_CHARS = 200;
/** The largest price a catalogue integer column holds. */
const MAX_PRICE_CENTS = 2_147_483_647;

async function requireCreator(viewer: Viewer) {
  if (viewer.role !== "creator") throw new Forbidden();
  const creator = await creatorFor(viewer.id);
  if (!creator) throw new Forbidden();
  return creator;
}

/**
 * The creator whose settings the viewer edits: her own, or for an admin the creator its console opens.
 * No actor column exists on these rows, so an admin's edit is not recorded as anyone's.
 */
async function requireSettingsCreator(viewer: Viewer) {
  if (viewer.role !== "creator" && viewer.role !== "admin") throw new Forbidden();
  const creator = await consoleCreatorFor(viewer);
  if (!creator) throw new Forbidden();
  return creator;
}

function requireAdmin(viewer: Viewer) {
  if (viewer.role !== "admin") throw new Forbidden();
}

/** A creator or admin who may see the conversation; a fan, or anyone out of scope, is refused. */
async function visibleToStaff(viewer: Viewer, conversationId: string) {
  if (viewer.role === "fan") throw new Forbidden();
  return assertVisible(viewer, conversationId);
}

/** Tells open pages to refetch: the conversation's thread, plus the inbox of whoever owns the queue. */
async function announce(events: Events, conv: { id: string; creatorId: string }, tsSide: boolean, event: string, extra: Record<string, unknown> = {}) {
  const payload = { conversationId: conv.id, ...extra };
  await Promise.allSettled([
    events.emit(`conversation:${conv.id}`, event, payload),
    events.emit(tsSide ? "ts" : `creator:${conv.creatorId}`, "inbox.changed", { conversationId: conv.id }),
  ]);
}

const isTsSide = (mode: string) => mode === "handoff_ts" || mode === "human_ts";

// ---- creator settings -------------------------------------------------------------------------------------

/** The global AI switch, kept by the engine (`creator_settings`). Its lease reads it on every turn. */
export async function setGlobalAi(viewer: Viewer, on: boolean): Promise<void> {
  const creator = await requireSettingsCreator(viewer);
  await (await chatter()).setCreatorAi(creator.id, on);
}

/** One conversation's AI switch. The creator must own it and it must not be on the Trust & Safety side. */
export async function setConversationAi(viewer: Viewer, conversationId: string, on: boolean): Promise<void> {
  await requireCreator(viewer);
  await assertVisible(viewer, conversationId);
  await db.update(conversations).set({ aiEnabled: on }).where(eq(conversations.id, conversationId));
}

/**
 * Replaces the never-talk-about list on the creator's live persona card (the newest published version, the only
 * card the engine reads on its next message). Terms are trimmed, deduplicated ignoring case and capped.
 */
export async function setNeverList(viewer: Viewer, terms: readonly string[]): Promise<string[]> {
  const creator = await requireSettingsCreator(viewer);
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const raw of terms) {
    const t = raw.replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (t.length > MAX_NEVER_TERM_CHARS) throw new InvalidInput("never_list");
    if (seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    clean.push(t);
  }
  if (clean.length > MAX_NEVER_TERMS) throw new InvalidInput("never_list");
  const [card] = await db
    .select({ id: personaCards.id })
    .from(personaCards)
    .where(and(eq(personaCards.creatorId, creator.id), isNotNull(personaCards.publishedAt)))
    .orderBy(desc(personaCards.version))
    .limit(1);
  if (!card) throw new InvalidInput("persona_card");
  await db.update(personaCards).set({ neverList: clean }).where(eq(personaCards.id, card.id));
  return clean;
}

/**
 * A catalogue price in whole cents. An open offer keeps the price it copied when it was made; only offers made
 * after this read the new one.
 */
export async function setItemPrice(viewer: Viewer, itemId: string, cents: number): Promise<void> {
  const creator = await requireSettingsCreator(viewer);
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_PRICE_CENTS) throw new InvalidAmount();
  const updated = await db
    .update(catalogueItems)
    .set({ priceCents: cents })
    .where(and(eq(catalogueItems.id, itemId), eq(catalogueItems.creatorId, creator.id)))
    .returning({ id: catalogueItems.id });
  if (updated.length === 0) throw new Forbidden();
}

/**
 * Adds an item to the end of the creator's catalogue and returns its id. The price is whole cents above zero; the
 * title is required, the teaser optional (blank is stored as none).
 */
export async function addItem(
  viewer: Viewer,
  input: { kind: string; title: string; teaser: string; cents: number },
): Promise<string> {
  const creator = await requireSettingsCreator(viewer);
  const kind = catalogueKindEnum.enumValues.find((k) => k === input.kind);
  if (!kind) throw new InvalidInput("kind");
  const title = String(input.title ?? "").trim();
  if (!title || title.length > MAX_ITEM_TITLE_CHARS) throw new InvalidInput("title");
  const teaser = String(input.teaser ?? "").trim();
  if (teaser.length > MAX_ITEM_TEASER_CHARS) throw new InvalidInput("teaser");
  if (!Number.isSafeInteger(input.cents) || input.cents <= 0 || input.cents > MAX_PRICE_CENTS) throw new InvalidAmount();
  return withTx(async (tx) => {
    // The same lock a move takes, so the next place is read after any add or move ahead of this one has committed.
    await lockCatalogue(tx, creator.id);
    const [row] = await tx
      .insert(catalogueItems)
      .values({
        creatorId: creator.id,
        kind,
        title,
        teaser: teaser || null,
        priceCents: input.cents,
        position: sql`coalesce((select max(${catalogueItems.position}) from ${catalogueItems} where ${catalogueItems.creatorId} = ${creator.id}), -1) + 1`,
      })
      .returning({ id: catalogueItems.id });
    return row.id;
  });
}

type Tx = Parameters<Parameters<typeof withTx>[0]>[0];

/**
 * Serialises everything that numbers a creator's catalogue (adding an item, moving one). The creator row is taken
 * first, so two adds to an empty shelf queue too, then her item rows in id order. Each statement after the lock is
 * its own, so it sees what the transaction ahead of it committed.
 */
async function lockCatalogue(tx: Tx, creatorId: string): Promise<void> {
  await tx.select({ id: creators.id }).from(creators).where(eq(creators.id, creatorId)).for("no key update");
  await tx.select({ id: catalogueItems.id }).from(catalogueItems).where(eq(catalogueItems.creatorId, creatorId)).orderBy(catalogueItems.id).for("no key update");
}

/**
 * Retires an item (inactive: the engine never offers it and the console offer picker hides it) or restores it.
 * Nothing deletes a row, because offers and unlocks point at it; an offer already open on a retired item can still
 * be unlocked.
 */
export async function setItemActive(viewer: Viewer, itemId: string, active: boolean): Promise<void> {
  const creator = await requireSettingsCreator(viewer);
  const updated = await db
    .update(catalogueItems)
    .set({ active })
    .where(and(eq(catalogueItems.id, itemId), eq(catalogueItems.creatorId, creator.id)))
    .returning({ id: catalogueItems.id });
  if (updated.length === 0) throw new Forbidden();
}

/**
 * Moves an active item one place up or down among the creator's active items, then renumbers all of the creator's
 * items 0..n-1 (retired ones keep their relative place). The creator's rows are locked first, in id order, so two
 * moves at once queue up and each reads the other's result; the lock is on catalogue rows only. At either end
 * nothing moves. A retired item has no place in the live list, so moving one does nothing.
 */
export async function moveItem(viewer: Viewer, itemId: string, direction: "up" | "down"): Promise<void> {
  const creator = await requireSettingsCreator(viewer);
  if (direction !== "up" && direction !== "down") throw new InvalidInput("direction");
  await withTx(async (tx) => {
    // The ordered read comes after the lock, as its own statement, so it sees what a move that held the lock committed.
    await lockCatalogue(tx, creator.id);
    const rows = await tx
      .select({ id: catalogueItems.id, position: catalogueItems.position, active: catalogueItems.active })
      .from(catalogueItems)
      .where(eq(catalogueItems.creatorId, creator.id))
      .orderBy(...catalogueOrder());
    const at = rows.findIndex((r) => r.id === itemId);
    if (at === -1) throw new Forbidden();
    const order = rows.map((r) => r.id);
    if (rows[at].active) {
      const step = direction === "up" ? -1 : 1;
      let other = at + step;
      while (other >= 0 && other < rows.length && !rows[other].active) other += step;
      if (other >= 0 && other < rows.length) [order[at], order[other]] = [order[other], order[at]];
    }
    const byId = new Map(rows.map((r) => [r.id, r.position]));
    for (const [i, id] of order.entries()) {
      if (byId.get(id) !== i) await tx.update(catalogueItems).set({ position: i }).where(eq(catalogueItems.id, id));
    }
  });
}

// ---- the human side of a conversation ---------------------------------------------------------------------

/** Takes the conversation for the viewer (the creator's own, or an admin's Trust & Safety one). */
export async function takeOverConversation(viewer: Viewer, conversationId: string, events: Events = defaultEvents()): Promise<void> {
  const conv = await visibleToStaff(viewer, conversationId);
  await takeover(conversationId, viewer.id);
  await announce(events, conv, viewer.role === "admin" || isTsSide(conv.mode), "conversation.mode");
  // An admin taking a chat off the creator's side removes it from her inbox too.
  if (viewer.role === "admin" && !isTsSide(conv.mode)) {
    await Promise.allSettled([events.emit(`creator:${conv.creatorId}`, "inbox.changed", { conversationId: conv.id })]);
  }
}

/** The creator hands her own conversation back to the AI. Admins use `release`. */
export async function handBackConversation(viewer: Viewer, conversationId: string, events: Events = defaultEvents()): Promise<void> {
  await requireCreator(viewer);
  const conv = await assertVisible(viewer, conversationId);
  await handBack(conv.id);
  await announce(events, conv, false, "conversation.mode");
}

async function insertHumanMessage(viewer: Viewer, conversationId: string, body: string, events: Events, clientMsgId: string | null = null): Promise<string> {
  const conv = await visibleToStaff(viewer, conversationId);
  const text = body.trim();
  if (!text || text.length > MAX_BODY_CHARS) throw new InvalidInput("body");
  let id: string;
  try {
    id = await chatterWithEvents(events).humanReply(conversationId, await humanActorOf(viewer.id), text, { clientMsgId });
  } catch (e) {
    if (e instanceof TakeoverRefused) throw new Forbidden();
    throw e;
  }
  await Promise.allSettled([events.emit(isTsSide(conv.mode) ? "ts" : `creator:${conv.creatorId}`, "inbox.changed", { conversationId })]);
  return id;
}

/**
 * The human replies in her own words. The conversation must already be in her human mode (taken over). `clientMsgId`
 * is the id her browser gave the bubble it shows while sending; it comes back on her reads so the two are one row.
 */
export async function sendAsCreator(
  viewer: Viewer,
  conversationId: string,
  body: string,
  events: Events = defaultEvents(),
  clientMsgId: string | null = null,
): Promise<string> {
  const id = typeof clientMsgId === "string" && clientMsgId.length >= 8 && clientMsgId.length <= 64 ? clientMsgId : null;
  return insertHumanMessage(viewer, conversationId, body, events, id);
}

/**
 * The creator offers a catalogue item from a chat she has taken over. The price is the item's catalogue price read
 * here, never an argument; the offer and its message are written like the engine writes them (offer row with the
 * configured expiry, then a message carrying `offer_id`), so the fan unlocks it through the same path. The mode and
 * the open-offer check run under the conversation row lock, so a hand-back or a double click cannot slip past them.
 */
export async function sendOfferAsCreator(viewer: Viewer, conversationId: string, itemId: string, events: Events = defaultEvents()): Promise<string> {
  await requireCreator(viewer);
  const conv = await assertVisible(viewer, conversationId);
  const ttlMinutes = await getConfig<number>("offer.ttl_minutes", conv.creatorId);
  const messageId = await withTx(async (tx) => {
    const [locked] = await tx.select().from(conversations).where(eq(conversations.id, conversationId)).for("update");
    if (!locked || locked.mode !== "human_creator") throw new Forbidden();
    const [item] = await tx
      .select({ id: catalogueItems.id, priceCents: catalogueItems.priceCents })
      .from(catalogueItems)
      .where(and(eq(catalogueItems.id, itemId), eq(catalogueItems.creatorId, locked.creatorId), eq(catalogueItems.active, true)));
    if (!item) throw new Forbidden();
    const open = await tx
      .select({ id: offers.id })
      .from(offers)
      .where(and(eq(offers.conversationId, conversationId), eq(offers.itemId, item.id), eq(offers.status, "open"), sql`${offers.expiresAt} > now()`))
      .limit(1);
    if (open.length > 0) throw new OfferAlreadyOpen();
    const [o] = await tx
      .insert(offers)
      .values({
        conversationId,
        itemId: item.id,
        priceCents: item.priceCents,
        expiresAt: sql`now() + make_interval(mins => ${ttlMinutes})`,
      })
      .returning({ id: offers.id });
    const [m] = await tx
      .insert(messages)
      .values({ conversationId, sender: "creator", senderUserId: viewer.id, body: CREATOR_OFFER_BODY, offerId: o.id })
      .returning({ id: messages.id });
    return m.id;
  });
  await Promise.allSettled([
    events.emit(`conversation:${conversationId}`, "message.created", { messageId, deliverInMs: 0 }),
    events.emit(`creator:${conv.creatorId}`, "inbox.changed", { conversationId }),
  ]);
  return messageId;
}

/**
 * Sends the AI's held draft with the human's edits, as the human's own message. Replying takes the conversation
 * over first, so the AI and the human never both answer. A never-list term in the edit is allowed: they are the
 * creator's own words.
 */
export async function sendSuggested(viewer: Viewer, messageId: string, editedBody: string, events: Events = defaultEvents()): Promise<string> {
  if (viewer.role === "fan") throw new Forbidden();
  const [row] = await db
    .select({ conversationId: messages.conversationId })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.suggested, true), eq(messages.status, "blocked")));
  if (!row) throw new ConversationNotFound();
  const conv = await assertVisible(viewer, row.conversationId);
  const text = editedBody.trim();
  if (!text || text.length > MAX_BODY_CHARS) throw new InvalidInput("body");
  const want = viewer.role === "admin" ? "human_ts" : "human_creator";
  if (conv.mode !== want) await takeover(conv.id, viewer.id);
  const sender = viewer.role === "admin" ? "admin" : "creator";
  const sent = await withTx(async (tx) => {
    const [locked] = await tx.select().from(conversations).where(eq(conversations.id, conv.id)).for("update");
    if (!locked || locked.mode !== want) throw new Forbidden();
    const updated = await tx
      .update(messages)
      .set({ sender, senderUserId: viewer.id, body: text, status: "sent", suggested: false, deliverAt: null, createdAt: sql`now()` as unknown as Date })
      .where(and(eq(messages.id, messageId), eq(messages.suggested, true), eq(messages.status, "blocked")))
      .returning({ id: messages.id });
    return updated.length > 0;
  });
  if (!sent) throw new ConversationNotFound();
  await Promise.allSettled([
    events.emit(`conversation:${conv.id}`, "message.created", { messageId, deliverInMs: 0 }),
    events.emit(isTsSide(conv.mode) ? "ts" : `creator:${conv.creatorId}`, "inbox.changed", { conversationId: conv.id }),
  ]);
  return messageId;
}

/** Drops the held draft without sending it. It stays on record as a blocked row. */
export async function discardSuggested(viewer: Viewer, messageId: string): Promise<void> {
  if (viewer.role === "fan") throw new Forbidden();
  const [row] = await db
    .select({ conversationId: messages.conversationId })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.suggested, true)));
  if (!row) throw new ConversationNotFound();
  await assertVisible(viewer, row.conversationId);
  await db.update(messages).set({ suggested: false }).where(eq(messages.id, messageId));
}

// ---- Trust & Safety ---------------------------------------------------------------------------------------

/** A chat locked for a fan seen as a minor never goes back to the AI; staff may still take it over or ban. */
async function refuseRestrictedRelease(fanId: string): Promise<void> {
  // The same rule as isRestrictedFan in lib/auth/guards.ts, which is not imported here because it loads Auth.js.
  const [fan] = await db.select({ flaggedAt: users.flaggedAt, flagReason: users.flagReason }).from(users).where(eq(users.id, fanId));
  if (fan?.flaggedAt && fan.flagReason === "minor_in_chat") throw new Forbidden();
}

/** Admin only. Resolves a Trust & Safety handoff and returns the conversation to the AI. */
export async function release(viewer: Viewer, handoffId: string, events: Events = defaultEvents()): Promise<void> {
  requireAdmin(viewer);
  const [h] = await db
    .select({ conversationId: handoffs.conversationId, queue: handoffs.queue, status: handoffs.status })
    .from(handoffs)
    .where(eq(handoffs.id, handoffId));
  if (!h || h.queue !== "ts") throw new ConversationNotFound();
  // A resolved handoff has nothing left to release (open and claimed ones do).
  if (h.status === "resolved") throw new ConversationNotFound();
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, h.conversationId));
  await refuseRestrictedRelease(conv.fanId);
  await handBack(h.conversationId, { allWaiting: true });
  await announce(events, conv, true, "conversation.mode");
}

/**
 * Admin only. Returns a conversation on the T&S side to the AI: through its unresolved T&S handoff when it has
 * one, else directly (an admin took it over from the AI or the creator, so no handoff was ever opened).
 */
export async function releaseConversation(viewer: Viewer, conversationId: string, events: Events = defaultEvents()): Promise<void> {
  requireAdmin(viewer);
  const conv = await assertVisible(viewer, conversationId);
  const [h] = await db
    .select({ id: handoffs.id })
    .from(handoffs)
    .where(and(eq(handoffs.conversationId, conversationId), eq(handoffs.queue, "ts"), ne(handoffs.status, "resolved")));
  if (h) return release(viewer, h.id, events);
  if (!isTsSide(conv.mode)) throw new ConversationNotFound();
  await refuseRestrictedRelease(conv.fanId);
  await handBack(conversationId, { allWaiting: true });
  await announce(events, conv, true, "conversation.mode");
  await Promise.allSettled([events.emit(`creator:${conv.creatorId}`, "inbox.changed", { conversationId: conv.id })]);
}

/**
 * Admin only. Flags a fan and ends their sessions, as the under-18 path does. A sent message is refused for a
 * flagged fan, and the next request resolves them to /blocked.
 */
export async function ban(viewer: Viewer, userId: string): Promise<void> {
  requireAdmin(viewer);
  await withTx(async (tx) => {
    const [target] = await tx.select({ role: users.role }).from(users).where(eq(users.id, userId));
    if (!target || target.role !== "fan") throw new Forbidden();
    await tx
      .update(users)
      .set({ flaggedAt: sql`coalesce(${users.flaggedAt}, now())`, flagReason: sql`coalesce(${users.flagReason}, 'banned by trust and safety')` })
      .where(eq(users.id, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
  });
}
