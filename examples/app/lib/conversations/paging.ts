import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { conversations, messages } from "@/db/schema";
import { decodeOlder, decodeSync, encodeOlder, encodeSync, isUuid } from "./cursor";
import {
  ConversationNotFound, fanCreator, scopeFor, selectThreadRows, rowLabel, suggestedIn, threadMeta, toThreadMessage, turnLabelText,
  type Snapshot, type Viewer,
} from "./read";
import { MESSAGE_PAGE_SIZE, type OlderPage, type ThreadChanges, type WindowedSnapshot } from "./window";

/**
 * The windowed thread reads: the newest page, older pages by keyset on (sort_at, id), and changes since a
 * sync cursor. Each one re-checks the viewer's scope through `scopeFor`, the same rule as `getThread`, and takes the
 * conversation from the caller (the session for a fan, the bound page id for staff), never from a cursor.
 */

/**
 * How far before a sync cursor a change read looks again. A write is stamped when it happens (`updated_at`, or an
 * insert's `now()`, the start of its transaction) but becomes visible only at commit. A transaction that stamped
 * its rows before a reader took its cursor and committed after that read would otherwise be missed for good. The
 * overlap re-reads those rows; the client upserts by id, so a row read twice is harmless.
 */
export const CHANGES_OVERLAP_MS = 5000;

const UTC_US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/**
 * The conversation if the viewer may see it, and the database clock read in the same statement. The clock is taken
 * before any rows are read, so a sync cursor is never later than the snapshot the rows came from.
 */
async function visibleAt(viewer: Viewer, conversationId: string) {
  if (!isUuid(conversationId)) throw new ConversationNotFound();
  const [row] = await db
    .select({ conv: conversations, now: sql<string>`to_char(now() at time zone 'utc', ${sql.raw(UTC_US)})` })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), scopeFor(viewer)));
  if (!row) throw new ConversationNotFound();
  return row;
}

async function dbNow(): Promise<string> {
  const r = await db.execute(sql`select to_char(now() at time zone 'utc', ${sql.raw(UTC_US)}) as now`);
  return (r.rows[0] as { now: string }).now;
}

/** Staff hover labels for exactly the bubbles returned, from the turn joined onto each row. */
function labelsOf(viewer: Viewer, rows: Parameters<typeof rowLabel>[0][]): Snapshot["labels"] {
  if (viewer.role === "fan") return {};
  const out: Snapshot["labels"] = {};
  for (const r of rows) {
    const l = rowLabel(r);
    if (l) out[l.messageId] = turnLabelText(l);
  }
  return out;
}

/** Up to `limit` visible bubbles strictly before `before` (or the newest, without it), newest first, plus one more to tell whether older ones exist. */
async function pageBefore(conversationId: string, before: { sortAt: string; id: string } | null, limit: number) {
  const where = before
    ? and(eq(messages.conversationId, conversationId), sql`(${messages.sortAt}, ${messages.id}) < (${before.sortAt}::timestamptz, ${before.id}::uuid)`)!
    : eq(messages.conversationId, conversationId);
  const rows = await selectThreadRows(where, [desc(messages.sortAt), desc(messages.id)], limit + 1);
  const more = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  const olderCursor = more && page.length > 0 ? encodeOlder({ conversationId, sortAt: page[0].sortKey, id: page[0].id }) : null;
  return { page, olderCursor };
}

/** The first load of a windowed thread: the newest MESSAGE_PAGE_SIZE visible bubbles, oldest first, and the cursors. */
export async function getWindowedSnapshot(viewer: Viewer, conversationId: string): Promise<WindowedSnapshot> {
  const { conv, now } = await visibleAt(viewer, conversationId);
  const [meta, { page, olderCursor }, suggested] = await Promise.all([
    threadMeta(viewer, conv),
    pageBefore(conversationId, null, MESSAGE_PAGE_SIZE),
    viewer.role === "fan" ? null : suggestedIn(conversationId),
  ]);
  const labels = labelsOf(viewer, page);
  return {
    thread: { ...meta, messages: page.map((r) => toThreadMessage(viewer, r)) },
    suggested,
    labels,
    window: { olderCursor, syncCursor: encodeSync(now) },
  };
}

/** The page of up to `limit` visible bubbles just before `before`, oldest first. */
export async function getOlderMessages(viewer: Viewer, conversationId: string, before: unknown, limit = MESSAGE_PAGE_SIZE): Promise<OlderPage> {
  const key = decodeOlder(before, conversationId);
  if (!isUuid(conversationId)) throw new ConversationNotFound();
  const n = Math.max(1, Math.min(MESSAGE_PAGE_SIZE * 4, Math.floor(Number(limit)) || MESSAGE_PAGE_SIZE));
  // The scope check and the page run together; the page is returned only once the check has passed.
  const [, { page, olderCursor }] = await Promise.all([visibleAt(viewer, conversationId), pageBefore(conversationId, key, n)]);
  return { messages: page.map((r) => toThreadMessage(viewer, r)), olderCursor, labels: labelsOf(viewer, page) };
}

/**
 * Every visible bubble that is new, was updated, became due, or whose offer changed state since `since` (less the
 * overlap), oldest first; the thread's small state whole; and a new sync cursor. Three index-backed id sets:
 * `updated_at` (inserts and every update, by the trigger), `sort_at` in (since, now()] (a bubble that just became
 * due, which no write touched), and offers updated or expired in that span (an unlock writes the offer, not the
 * bubble; an expiry writes nothing).
 */
export async function getChanges(viewer: Viewer, conversationId: string, since: unknown): Promise<ThreadChanges> {
  const t = decodeSync(since);
  const { conv, now } = await visibleAt(viewer, conversationId);
  const from = sql`(${t}::timestamptz - make_interval(secs => ${CHANGES_OVERLAP_MS / 1000}))`;
  const changed = sql`${messages.id} in (
    select m.id from messages m where m.conversation_id = ${conversationId} and m.updated_at > ${from}
    union
    select m.id from messages m where m.conversation_id = ${conversationId} and m.sort_at > ${from} and m.sort_at <= now()
    union
    select m.id from offers o join messages m on m.offer_id = o.id
    where o.conversation_id = ${conversationId} and m.offer_id is not null
      and (o.updated_at > ${from} or (o.expires_at > ${from} and o.expires_at <= now()))
  )`;
  const [meta, rows, suggested] = await Promise.all([
    threadMeta(viewer, conv),
    selectThreadRows(and(eq(messages.conversationId, conversationId), changed)!, [sql`${messages.sortAt} asc`, sql`${messages.id} asc`]),
    viewer.role === "fan" ? null : suggestedIn(conversationId),
  ]);
  const labels = labelsOf(viewer, rows);
  return { upserts: rows.map((r) => toThreadMessage(viewer, r)), syncCursor: encodeSync(now), thread: meta, suggested, labels };
}

// ---- the fan's one thread, found from the session ----------------------------------------------------------------

async function fanThread(fanId: string, handle?: string | null) {
  const creator = await fanCreator(handle);
  if (!creator) return null;
  const [conv] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.creatorId, creator.id), eq(conversations.fanId, fanId)));
  return { creator, conversationId: conv?.id ?? null };
}

/** Before his first message a fan has no conversation row: an empty thread, as `getFanSnapshot` shows it. */
function emptyFanMeta(fanId: string, creator: { id: string; displayName: string; image: string | null }): ThreadChanges["thread"] {
  return {
    conversation: { id: "", mode: "ai", aiEnabled: true, fanName: "", creatorName: creator.displayName, creatorImage: creator.image, creatorId: creator.id, fanId, fanRestricted: false },
    pendingMs: [],
    aiPending: false,
    handoff: null,
  };
}

/** The windowed form of `getFanSnapshot`. */
export async function getFanWindowedSnapshot(
  fanId: string,
  handle?: string | null,
): Promise<{ snapshot: WindowedSnapshot; creator: { id: string; displayName: string; handle: string; image: string | null } } | null> {
  const found = await fanThread(fanId, handle);
  if (!found) return null;
  const { creator, conversationId } = found;
  const info = { id: creator.id, displayName: creator.displayName, handle: creator.handle, image: creator.image };
  if (conversationId) return { snapshot: await getWindowedSnapshot({ id: fanId, role: "fan" }, conversationId), creator: info };
  return {
    creator: info,
    snapshot: {
      suggested: null,
      labels: {},
      thread: { ...emptyFanMeta(fanId, creator), messages: [] },
      window: { olderCursor: null, syncCursor: encodeSync(await dbNow()) },
    },
  };
}

export async function getFanOlderMessages(fanId: string, handle: string | null | undefined, before: unknown): Promise<OlderPage> {
  const found = await fanThread(fanId, handle);
  // No conversation yet: nothing is older, and there is no conversation for an older cursor to name.
  if (!found?.conversationId) return { messages: [], olderCursor: null, labels: {} };
  return getOlderMessages({ id: fanId, role: "fan" }, found.conversationId, before);
}

export async function getFanChanges(fanId: string, handle: string | null | undefined, since: unknown): Promise<ThreadChanges> {
  const found = await fanThread(fanId, handle);
  if (!found) throw new ConversationNotFound();
  if (found.conversationId) return getChanges({ id: fanId, role: "fan" }, found.conversationId, since);
  decodeSync(since);
  return { upserts: [], syncCursor: encodeSync(await dbNow()), thread: emptyFanMeta(fanId, found.creator), suggested: null, labels: {} };
}
