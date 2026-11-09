import { and, asc, desc, eq, exists, getTableColumns, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { db } from "@/db/client";
import { catalogueItems, conversations, creators, creatorSettings, handoffs, messages, offers, turns, users } from "@/db/schema";
import type { Role } from "@/lib/auth/guards";
import { inboxBadge, type InboxMode } from "@/lib/ui/inbox-badge";

/** Who is asking. `id` comes from the session, never from a request. */
export interface Viewer {
  id: string;
  role: Role;
}

export class ConversationNotFound extends Error {
  constructor() {
    super("conversation not found");
    this.name = "ConversationNotFound";
  }
}

const tsHandoff = (any: boolean) =>
  exists(
    db
      .select({ one: sql`1` })
      .from(handoffs)
      .where(and(eq(handoffs.conversationId, conversations.id), eq(handoffs.queue, "ts"), any ? undefined : ne(handoffs.status, "resolved"))),
  );

/**
 * The one place that decides which conversations a viewer may see; every read below is filtered by it.
 * A creator sees her own conversations that are not on the Trust & Safety side (mode, or an unresolved ts
 * handoff). An admin sees every conversation (so Trust & Safety can step in anywhere). A fan sees their own.
 */
export function scopeFor(viewer: Viewer): SQL {
  if (viewer.role === "fan") return eq(conversations.fanId, viewer.id);
  if (viewer.role === "admin") return sql`true`;
  return and(
    inArray(conversations.creatorId, db.select({ id: creators.id }).from(creators).where(eq(creators.userId, viewer.id))),
    sql`${conversations.mode} not in ('handoff_ts','human_ts')`,
    sql`not ${tsHandoff(false)}`,
  )!;
}

/** Throws ConversationNotFound unless the viewer may see the conversation. Returns the row. */
export async function assertVisible(viewer: Viewer, conversationId: string) {
  const [row] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), scopeFor(viewer)));
  if (!row) throw new ConversationNotFound();
  return row;
}

/** A message the fan may see: sent, not a held draft, and due. */
const fanVisible = sql`${messages.status} = 'sent' and not ${messages.suggested} and (${messages.deliverAt} is null or ${messages.deliverAt} <= now())`;

export interface InboxRow {
  id: string;
  fanName: string;
  preview: string;
  ageMs: number;
  mode: InboxMode;
  aiEnabled: boolean;
  badge: string | null;
  hasSuggestion: boolean;
}

function displayName(name: string | null, email: string | null): string {
  return name?.trim() || email?.split("@")[0] || "Fan";
}

/** The viewer's conversations, newest activity first. Creators and admins only. */
export async function listInbox(viewer: Viewer): Promise<InboxRow[]> {
  if (viewer.role === "fan") throw new ConversationNotFound();
  const rows = await db
    .select({
      id: conversations.id,
      mode: conversations.mode,
      aiEnabled: conversations.aiEnabled,
      fanName: users.name,
      fanEmail: users.email,
      createdAt: conversations.createdAt,
      lastBody: sql<string | null>`(select m.body from messages m where m.conversation_id = ${conversations.id} and m.status = 'sent' and not m.suggested and (m.deliver_at is null or m.deliver_at <= now()) order by coalesce(m.deliver_at, m.created_at) desc, m.id desc limit 1)`,
      lastSender: sql<string | null>`(select m.sender::text from messages m where m.conversation_id = ${conversations.id} and m.status = 'sent' and not m.suggested and (m.deliver_at is null or m.deliver_at <= now()) order by coalesce(m.deliver_at, m.created_at) desc, m.id desc limit 1)`,
      lastAgeMs: sql<number | null>`(select extract(epoch from now() - coalesce(m.deliver_at, m.created_at)) * 1000 from messages m where m.conversation_id = ${conversations.id} and m.status = 'sent' and not m.suggested and (m.deliver_at is null or m.deliver_at <= now()) order by coalesce(m.deliver_at, m.created_at) desc, m.id desc limit 1)::float8`,
      openCreatorHandoff: sql<boolean>`exists (select 1 from handoffs h where h.conversation_id = ${conversations.id} and h.queue = 'creator' and h.status <> 'resolved')`,
      hasSuggestion: sql<boolean>`exists (select 1 from messages m where m.conversation_id = ${conversations.id} and m.suggested and m.status = 'blocked')`,
      ageMs: sql<number>`extract(epoch from now() - ${conversations.createdAt}) * 1000`,
    })
    .from(conversations)
    .innerJoin(users, eq(users.id, conversations.fanId))
    .where(scopeFor(viewer))
    .orderBy(
      // Admin: chats on the T&S side first, then everything by latest activity.
      viewer.role === "admin" ? sql`case when ${conversations.mode} in ('handoff_ts','human_ts') or ${tsHandoff(false)} then 0 else 1 end` : sql`'0'::text`,
      sql`coalesce((select max(coalesce(m.deliver_at, m.created_at)) from messages m where m.conversation_id = ${conversations.id}), ${conversations.createdAt}) desc`,
      desc(conversations.id),
    );

  return rows.map((r) => ({
    id: r.id,
    fanName: displayName(r.fanName, r.fanEmail),
    preview: r.lastBody ? `${r.lastSender === "fan" ? "" : "You: "}${r.lastBody}` : "No messages yet",
    ageMs: Number(r.lastAgeMs ?? r.ageMs),
    mode: r.mode,
    aiEnabled: r.aiEnabled,
    hasSuggestion: r.hasSuggestion,
    badge: inboxBadge({
      mode: r.mode,
      aiEnabled: r.aiEnabled,
      openCreatorHandoff: r.openCreatorHandoff,
      viewer: viewer.role === "admin" ? "admin" : "creator",
    }),
  }));
}

export interface ThreadMessage {
  id: string;
  sender: "fan" | "ai" | "creator" | "admin" | "system";
  body: string;
  /** ISO time the bubble became (or becomes) visible. */
  at: string;
  /** Milliseconds since `at`, by the database clock. */
  ageMs: number;
  /** The id the fan's browser gave this message when sending it; only on the fan's own messages, for the fan. */
  clientMsgId: string | null;
  offer: null | {
    id: string;
    title: string;
    teaser: string;
    priceCents: number;
    state: "locked" | "unlocked" | "expired";
  };
}

export interface Thread {
  conversation: {
    id: string;
    mode: InboxMode;
    aiEnabled: boolean;
    fanName: string;
    creatorName: string;
    /** The creator's profile photo (her user's `image`), or null for initials. */
    creatorImage: string | null;
    creatorId: string;
    fanId: string;
    /** The fan is restricted as a minor seen in chat (`minor_in_chat`): read-only, and never handed to the AI. */
    fanRestricted: boolean;
  };
  messages: ThreadMessage[];
  /**
   * Milliseconds (database clock) until each bubble that is not yet due, soonest first. Carries no text: it
   * lets a reloaded page show the typing row and schedule a refetch.
   */
  pendingMs: number[];
  /** True while the AI owes the fan an answer (a recent unanswered fan message, AI mode, switches on). */
  aiPending: boolean;
  handoff: null | { queue: "creator" | "ts"; reason: string; status: "open" | "claimed" | "resolved"; claimedByYou: boolean };
}

/** An unanswered fan message older than this is treated as a stuck turn, not "typing". */
export const AI_PENDING_WINDOW_MS = 90_000;

/**
 * The columns of one thread bubble, with its offer. Shared by the whole-thread read and the windowed reads
 * so a bubble looks the same whichever read produced it.
 */
export const threadRowFields = {
  id: messages.id,
  sender: messages.sender,
  body: messages.body,
  clientMsgId: messages.clientMsgId,
  senderUserId: messages.senderUserId,
  at: sql<string>`to_char(coalesce(${messages.deliverAt}, ${messages.createdAt}) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
  ageMs: sql<number>`(extract(epoch from now() - coalesce(${messages.deliverAt}, ${messages.createdAt})) * 1000)::float8`,
  offerId: offers.id,
  offerStatus: offers.status,
  offerLive: sql<boolean>`${offers.expiresAt} > now()`,
  offerPrice: offers.priceCents,
  title: catalogueItems.title,
  teaser: catalogueItems.teaser,
  /** The turn behind the bubble, for staff hover labels (only an AI bubble's turn is a label, as in `getTurnLabels`). */
  turnId: turns.id,
  turnRoute: sql<string | null>`${turns.route}::text`,
  turnOutcome: turns.outcome,
  turnMs: turns.msTotal,
  turnCostMicros: turns.costMicros,
  /** `sort_at` to the microsecond, for the keyset cursor of a windowed read. */
  sortKey: sql<string>`to_char(${messages.sortAt} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
};

type ThreadRow = {
  id: string;
  sender: ThreadMessage["sender"];
  body: string;
  clientMsgId: string | null;
  senderUserId: string | null;
  at: string;
  ageMs: number;
  offerId: string | null;
  offerStatus: string | null;
  offerLive: boolean | null;
  offerPrice: number | null;
  title: string | null;
  teaser: string | null;
};

/** Visible bubbles of one conversation matching `where`, with their offers, in the order and count asked for. */
export function selectThreadRows(where: SQL, orderBy: SQL[], limit?: number) {
  const q = db
    .select(threadRowFields)
    .from(messages)
    .leftJoin(offers, eq(offers.id, messages.offerId))
    .leftJoin(catalogueItems, eq(catalogueItems.id, offers.itemId))
    .leftJoin(turns, eq(turns.id, messages.turnId))
    .where(and(where, fanVisible))
    .orderBy(...orderBy);
  return limit === undefined ? q : q.limit(limit);
}

/** The hover label of a selected bubble, or null: staff only, AI bubbles with a turn. */
export function rowLabel(r: { id: string; sender: string; turnId: string | null; turnRoute: string | null; turnOutcome: string | null; turnMs: number | null; turnCostMicros: number | null }): TurnLabel | null {
  if (r.sender !== "ai" || !r.turnId) return null;
  return { messageId: r.id, route: r.turnRoute, outcome: r.turnOutcome, ms: r.turnMs, costMicros: r.turnCostMicros };
}

export function toThreadMessage(viewer: Viewer, r: ThreadRow): ThreadMessage {
  return {
    id: r.id,
    sender: r.sender,
    // Only the writer gets the id their browser gave the message: it matches the bubble they are already showing.
    clientMsgId: (viewer.role === "fan" && r.sender === "fan") || (r.senderUserId !== null && r.senderUserId === viewer.id) ? r.clientMsgId : null,
    body: r.body,
    at: r.at,
    ageMs: Math.max(0, Math.round(Number(r.ageMs))),
    offer: r.offerId
      ? {
          id: r.offerId,
          title: r.title ?? "",
          teaser: r.teaser ?? "",
          priceCents: r.offerPrice!,
          state: r.offerStatus === "accepted" ? "unlocked" : r.offerStatus === "open" && r.offerLive ? "locked" : "expired",
        }
      : null,
  };
}

type ConversationRow = Awaited<ReturnType<typeof assertVisible>>;

/** Everything about a thread except its bubbles: names, mode, the due-bubble timers, the AI's typing state, the handoff. */
export async function threadMeta(viewer: Viewer, conv: ConversationRow): Promise<Omit<Thread, "messages">> {
  const conversationId = conv.id;
  const [[fan], [creator], pending, [h], [pendingTurn]] = await Promise.all([
    db.select({ name: users.name, email: users.email, flaggedAt: users.flaggedAt, flagReason: users.flagReason }).from(users).where(eq(users.id, conv.fanId)),
    db
      .select({ displayName: creators.displayName, aiEnabled: sql<boolean>`coalesce(${creatorSettings.aiEnabled}, true)`, image: users.image })
      .from(creators)
      .leftJoin(users, eq(users.id, creators.userId))
      .leftJoin(creatorSettings, eq(creatorSettings.creatorId, creators.id))
      .where(eq(creators.id, conv.creatorId)),
    db
      .select({ ms: sql<number>`(extract(epoch from ${messages.deliverAt} - now()) * 1000)::float8` })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.status, "sent"), eq(messages.suggested, false), sql`${messages.deliverAt} > now()`))
      .orderBy(asc(messages.deliverAt)),
    db
      .select({ queue: handoffs.queue, reason: handoffs.reason, status: handoffs.status, claimedBy: handoffs.claimedBy })
      .from(handoffs)
      .where(and(eq(handoffs.conversationId, conversationId), ne(handoffs.status, "resolved")))
      .limit(1),
    db
      .select({ one: sql<number>`1` })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.sender, "fan"),
          isNull(messages.turnId),
          sql`${messages.createdAt} > now() - make_interval(secs => ${AI_PENDING_WINDOW_MS / 1000})`,
        ),
      )
      .limit(1),
  ]);

  const handoff = h && (viewer.role === "fan" ? null : h);
  return {
    conversation: {
      id: conv.id,
      mode: conv.mode,
      aiEnabled: conv.aiEnabled,
      fanName: displayName(fan?.name ?? null, fan?.email ?? null),
      creatorName: creator?.displayName ?? "",
      creatorImage: creator?.image ?? null,
      creatorId: conv.creatorId,
      fanId: conv.fanId,
      // As guards.isRestrictedFan, with the literal: guards pulls in Auth.js, which this read module must not load.
      fanRestricted: Boolean(fan?.flaggedAt) && fan?.flagReason === "minor_in_chat",
    },
    pendingMs: pending.map((p) => Math.max(0, Math.round(p.ms))),
    aiPending: Boolean(pendingTurn) && conv.mode === "ai" && conv.aiEnabled && Boolean(creator?.aiEnabled),
    handoff: handoff ? { queue: handoff.queue, reason: handoff.reason, status: handoff.status, claimedByYou: handoff.claimedBy === viewer.id } : null,
  };
}

/** The thread as this viewer may see it, every bubble. Throws ConversationNotFound outside their scope. */
export async function getThread(viewer: Viewer, conversationId: string): Promise<Thread> {
  const conv = await assertVisible(viewer, conversationId);
  const [meta, rows] = await Promise.all([
    threadMeta(viewer, conv),
    selectThreadRows(eq(messages.conversationId, conversationId), [
      asc(sql`coalesce(${messages.deliverAt}, ${messages.createdAt})`),
      asc(messages.createdAt),
      asc(messages.id),
    ]),
  ]);
  return { ...meta, messages: rows.map((r) => toThreadMessage(viewer, r)) };
}

export interface Suggested {
  id: string;
  body: string;
}

/** The draft the AI held for the creator to edit and send, if one is waiting. Creators and admins only. */
export async function getSuggested(viewer: Viewer, conversationId: string): Promise<Suggested | null> {
  if (viewer.role === "fan") throw new ConversationNotFound();
  await assertVisible(viewer, conversationId);
  return suggestedIn(conversationId);
}

/** The waiting draft, for a caller that has already checked the viewer is staff and in scope. */
export async function suggestedIn(conversationId: string): Promise<Suggested | null> {
  const [row] = await db
    .select({ id: messages.id, body: messages.body })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.suggested, true), eq(messages.status, "blocked")))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  return row ?? null;
}

export interface TurnLabel {
  messageId: string;
  route: string | null;
  outcome: string | null;
  ms: number | null;
  costMicros: number | null;
}

/** Turn labels for the console's hover text: which turn produced each AI bubble. Never given to a fan. */
export async function getTurnLabels(viewer: Viewer, conversationId: string): Promise<TurnLabel[]> {
  if (viewer.role === "fan") throw new ConversationNotFound();
  await assertVisible(viewer, conversationId);
  const rows = await db.execute(sql`
    select m.id as "messageId", t.route::text as route, t.outcome, t.ms_total as ms, t.cost_micros as "costMicros"
    from messages m join turns t on t.id = m.turn_id
    where m.conversation_id = ${conversationId} and m.sender = 'ai'`);
  return rows.rows as unknown as TurnLabel[];
}

/** The creator row for a signed-in creator user, or null. */
export async function creatorFor(userId: string) {
  const [row] = await db.select().from(creators).where(eq(creators.userId, userId));
  return row ?? null;
}

/**
 * The creator whose console this viewer opens: a creator's own row; for an admin, the platform's creator
 * that fans talk to (`primaryCreator`: one today, the first by unique handle, since `creators` has no created_at);
 * null for a fan. Nothing from the request picks it, so an admin cannot be steered to another creator by URL.
 */
export async function consoleCreatorFor(viewer: Viewer) {
  if (viewer.role === "creator") return creatorFor(viewer.id);
  if (viewer.role !== "admin") return null;
  return primaryCreator();
}

/** May this viewer subscribe to a realtime channel? Conversation channels follow exactly the thread scope. */
export async function canSubscribe(
  viewer: Viewer,
  channel: { kind: "conversation"; id: string } | { kind: "creator"; id: string } | { kind: "ts" },
): Promise<boolean> {
  if (channel.kind === "ts") return viewer.role === "admin";
  if (channel.kind === "creator") {
    // An admin sees every conversation, so a creator's inbox events are within its scope (its console view).
    if (viewer.role === "admin") return true;
    if (viewer.role !== "creator") return false;
    return (await creatorFor(viewer.id))?.id === channel.id;
  }
  try {
    await assertVisible(viewer, channel.id);
    return true;
  } catch (e) {
    if (e instanceof ConversationNotFound) return false;
    throw e;
  }
}

/** Everything one open thread needs to render, refetched whole whenever an event says something changed. */
export interface Snapshot {
  thread: Thread;
  suggested: Suggested | null;
  /** AI message id -> "route, outcome, ms, cost". Staff only. */
  labels: Record<string, string>;
}

export function turnLabelText(l: TurnLabel): string {
  const parts = [l.route, l.outcome, l.ms == null ? null : `${l.ms} ms`, l.costMicros == null ? null : `$${(l.costMicros / 1_000_000).toFixed(4)}`];
  return parts.filter(Boolean).join(" · ");
}

export async function getSnapshot(viewer: Viewer, conversationId: string): Promise<Snapshot> {
  const thread = await getThread(viewer, conversationId);
  if (viewer.role === "fan") return { thread, suggested: null, labels: {} };
  const [suggested, labels] = await Promise.all([getSuggested(viewer, conversationId), getTurnLabels(viewer, conversationId)]);
  return { thread, suggested, labels: Object.fromEntries(labels.map((l) => [l.messageId, turnLabelText(l)])) };
}

/** The platform's creator. There is one today; a fan talks to her. */
/** The platform's one creator, with her profile photo (her user's `image`). */
export async function primaryCreator() {
  const [row] = await db
    .select({ ...getTableColumns(creators), image: users.image })
    .from(creators)
    .leftJoin(users, eq(users.id, creators.userId))
    .orderBy(asc(creators.handle))
    .limit(1);
  return row ?? null;
}

/**
 * A fan's one thread with the platform's creator, found from the session's user id. Before the first message
 * there is no conversation row, so the snapshot is empty (conversation id "") and the page still renders.
 */
export async function getFanSnapshot(fanId: string): Promise<{ snapshot: Snapshot; creator: { id: string; displayName: string; handle: string; image: string | null } } | null> {
  const creator = await primaryCreator();
  if (!creator) return null;
  const [conv] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.creatorId, creator.id), eq(conversations.fanId, fanId)));
  const info = { id: creator.id, displayName: creator.displayName, handle: creator.handle, image: creator.image };
  if (conv) return { snapshot: await getSnapshot({ id: fanId, role: "fan" }, conv.id), creator: info };
  return {
    creator: info,
    snapshot: {
      suggested: null,
      labels: {},
      thread: {
        conversation: { id: "", mode: "ai", aiEnabled: true, fanName: "", creatorName: creator.displayName, creatorImage: creator.image, creatorId: creator.id, fanId, fanRestricted: false },
        messages: [],
        pendingMs: [],
        aiPending: false,
        handoff: null,
      },
    },
  };
}
