import type { Snapshot, ThreadMessage } from "@/lib/conversations/read";
import type { ThreadChanges } from "@/lib/conversations/window";

/**
 * The client's message store for a windowed thread. Messages are kept oldest first, ordered by `at` and then
 * id, and keyed by id: an older page is prepended, a change read is upserted, and either may overlap what is already
 * held without duplicating a bubble.
 */

/** Oldest first: by the time the bubble became visible, then by id so equal times keep one stable order. */
export function compareMessages(a: Pick<ThreadMessage, "at" | "id">, b: Pick<ThreadMessage, "at" | "id">): number {
  const d = Date.parse(a.at) - Date.parse(b.at);
  if (d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The list in store order; returns the same array when it is already sorted, so most updates skip the sort. */
export function sortMessages(messages: ThreadMessage[]): ThreadMessage[] {
  for (let i = 1; i < messages.length; i++) {
    if (compareMessages(messages[i - 1], messages[i]) > 0) return [...messages].sort(compareMessages);
  }
  return messages;
}

/** Prepends an older page. A message already held wins over the page's copy, since it was read more recently. */
export function mergeOlder(current: ThreadMessage[], older: readonly ThreadMessage[]): ThreadMessage[] {
  const held = new Set(current.map((m) => m.id));
  const fresh = older.filter((m) => !held.has(m.id));
  if (fresh.length === 0) return current;
  return sortMessages([...fresh, ...current]);
}

/** Inserts new messages and replaces held ones by id (an offer that was unlocked, a bubble that became due). */
export function upsertMessages(current: ThreadMessage[], upserts: readonly ThreadMessage[]): ThreadMessage[] {
  if (upserts.length === 0) return current;
  const index = new Map(current.map((m, i) => [m.id, i]));
  const next = [...current];
  for (const m of upserts) {
    const i = index.get(m.id);
    if (i === undefined) {
      index.set(m.id, next.length);
      next.push(m);
    } else {
      next[i] = m;
    }
  }
  return sortMessages(next);
}

/**
 * Applies a change read to a snapshot: messages are upserted, and the thread's small state (mode, pending bubbles,
 * handoff) and the suggested reply are replaced. Turn labels are merged rather than replaced, so a label already shown
 * on an older loaded message is kept when the server only labels the messages it just returned.
 */
export function applyChanges(snap: Snapshot, changes: Omit<ThreadChanges, "syncCursor">): Snapshot {
  return {
    thread: { ...changes.thread, messages: upsertMessages(snap.thread.messages, changes.upserts) },
    suggested: changes.suggested,
    labels: { ...snap.labels, ...changes.labels },
  };
}

/** A whole snapshot read as a change: its messages are upserted, so pages of history already loaded stay. */
export function mergeSnapshot(snap: Snapshot, next: Snapshot): Snapshot {
  const { messages, ...thread } = next.thread;
  return applyChanges(snap, { upserts: messages, thread, suggested: next.suggested, labels: next.labels });
}

/** A fan message shown before the server has confirmed it, keyed by the id the browser gave it. */
export interface PendingMessage {
  id: string;
  text: string;
  at: number;
  /** The read sequence number current when the send was acknowledged; any read after it holds the message. */
  afterSeq?: number;
}

/**
 * Drops the pending bubbles a read has confirmed: one whose message came back (matched by clientMsgId), or one whose
 * send was acknowledged before read number `seq` started. The fan never sees his message twice, however the send and
 * the reads interleave.
 */
export function reconcilePending<P extends PendingMessage>(
  pending: P[],
  incoming: readonly Pick<ThreadMessage, "clientMsgId">[],
  seq: number,
): P[] {
  const saved = new Set(incoming.map((m) => m.clientMsgId));
  const kept = pending.filter((x) => !saved.has(x.id) && (x.afterSeq === undefined || seq <= x.afterSeq));
  return kept.length === pending.length ? pending : kept;
}
