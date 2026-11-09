import type { Snapshot, Thread, ThreadMessage } from "./read";

/**
 * Message windowing contract. A thread view starts with the newest `MESSAGE_PAGE_SIZE` messages, loads older
 * pages as the reader scrolls up, and keeps itself current with changes-only refreshes instead of refetching the whole
 * conversation. The server side (paged reads, change reads, the `sort_at` / `updated_at` columns) and the client side
 * (the windowed list, scroll-up loading, merging changes) are built against these types.
 *
 * Cursors are opaque strings made and read only by the server. Clients store and send them back and never parse them.
 */

/** Messages in the first load and in each older page. */
export const MESSAGE_PAGE_SIZE = 15;

export type Cursor = string;

/** Where a loaded window sits: the cursor for the next older page (null at the start of the chat) and for change reads. */
export interface WindowCursors {
  olderCursor: Cursor | null;
  syncCursor: Cursor;
}

/** The snapshot of a windowed first load: only the newest page in `thread.messages`, plus its cursors. */
export type WindowedSnapshot = Snapshot & { window: WindowCursors };

/** One older page, oldest first, ending just before the cursor it was asked for. */
export interface OlderPage {
  messages: ThreadMessage[];
  olderCursor: Cursor | null;
  /** Staff only: the turn labels of this page's AI bubbles, to merge into the view's labels (empty for a fan). */
  labels?: Snapshot["labels"];
}

/**
 * What changed since a sync cursor: every message that is new, was updated (offer state, a sent suggestion, a status
 * change) or became due for this viewer, oldest first, to upsert by id; plus the thread's current small state
 * (`thread`, `suggested`), which is replaced whole. `labels` holds only the upserted bubbles' labels, so it is merged
 * into the view's labels, not swapped for them. The server reads a short overlap before the cursor so a row committed late is never missed; the
 * client's upsert-by-id makes the overlap harmless.
 */
export interface ThreadChanges {
  upserts: ThreadMessage[];
  syncCursor: Cursor;
  thread: Omit<Thread, "messages">;
  suggested: Snapshot["suggested"];
  labels: Snapshot["labels"];
}
