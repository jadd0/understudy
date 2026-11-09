# Realtime

Pusher Channels. The database is the truth; an event only says "refetch".

## Channels and events

| Channel | Who may subscribe | Used by |
|---|---|---|
| `private-conversation-<conversation id>` | the fan who owns it; the owning creator unless it is on the Trust & Safety side; any admin (the admin read scope is every conversation) | the open thread |
| `private-creator-<creator id>` | that creator, and any admin | the creator's inbox; an admin's console inbox |
| `private-ts` | admins | the T&S queue |

| Event (browser name) | Emitted when | Engine's own name |
|---|---|---|
| `typing.start` `{ holdMs }` | a turn commits and bubbles are queued | `typing` |
| `message.new` `{ messageId, deliverInMs }` | one per bubble; also a human reply or a sent suggestion | `message.created` |
| `conversation.mode` `{ conversationId }` | takeover, hand-back, release | none (server actions emit it) |
| `inbox.changed` `{ conversationId }` | a fan message, a human reply, a mode change, a tip, and an engine commit that applied (a reply, a hold or a hard stop) | `inbox.changed`, on `creator:<id>` |

The engine emits on `conversation:<id>` with the names in the right-hand column. `providers/pusher/events.ts` maps
them to the Pusher names above, because Pusher channel names cannot contain `:` and a private channel needs the
`private-` prefix. A payload keeps only numbers, booleans and uuid-shaped strings, so a message body can never
travel through Pusher (`idsOnly`, tested).

## Authorisation

`POST /api/pusher/auth` (`app/api/pusher/auth/route.ts`) reads the Auth.js session, reads the user row fresh
(role, flag), parses the channel name against the three shapes above, and asks `canSubscribe`
(`lib/conversations/read.ts`). A conversation channel follows exactly the thread scope: whoever may not read the
thread may not subscribe. Anything else is a 403.

## What the browser does

`components/chat/live-thread.tsx` renders the first snapshot from the server, then refetches on any event: the
whole snapshot (`getSnapshot`), or only the changes once the view is windowed (see Message windowing). Rows are keyed by message id, so an early or repeated event cannot duplicate a bubble.

- A bubble whose `deliver_at` is still ahead is hidden by the database. `getThread` returns `pendingMs` (database
  clock, no text), and the client schedules one refetch just after each, plus slack.
- Typing shows from the fan's send until the last pending bubble is due. `aiPending` (a fresh unanswered fan
  message in an AI-mode conversation) keeps it on after a reload and polls every 2.5 s, so a turn that ends in a
  handoff, which emits nothing, still clears it.
- Without Pusher keys the adapter is the no-op and the thread polls every 3 s. Inboxes refresh every 5 s (30 s when
  Pusher is on, as a backstop for events nobody emits).

## Message windowing

A thread no longer reads the whole conversation on every refresh. The server side lives in
`lib/conversations/paging.ts`, the cursors in `lib/conversations/cursor.ts`, and the shapes in
`lib/conversations/window.ts`.

- **First load** (`getWindowedSnapshot`, `getFanWindowedSnapshot`): the newest `MESSAGE_PAGE_SIZE` (15) visible
  bubbles, oldest first, plus `window: { olderCursor, syncCursor }`. The pages call it. The fan's visibility rules
  are the same filter `getThread` uses.
- **Older page** (`getOlderMessages`, the `older` action): keyset on `(sort_at, id) < cursor`, newest first,
  `limit + 1` rows to know whether more exist, returned oldest first. `sort_at` is a stored generated column,
  `coalesce(deliver_at, created_at)`, indexed `(conversation_id, sort_at desc, id desc)`.
- **Changes** (`getChanges`, the `changes` action): the union of three index-backed id sets since
  `cursor − CHANGES_OVERLAP_MS`: rows with `updated_at` after it, rows whose `sort_at` falls in `(it, now()]` (a
  bubble that just became due, which nothing wrote), and bubbles whose offer was updated or expired in that span.
  `thread` and `suggested` come back whole; `labels` only for the upserted bubbles, to merge.
- `messages.updated_at` and `offers.updated_at` are set by one `BEFORE UPDATE` trigger (`set_updated_at`, using
  `clock_timestamp()`), so every write path is covered without touching call sites.
- **The overlap.** A row is stamped when written but visible only at commit, so a transaction that stamped before
  a reader's cursor and committed after it would be missed. Each change read looks 5 s back past its cursor; the
  client upserts by id, so a row read twice is harmless.
- **Cursors** are base64url JSON made only by the server. Each read decodes and checks every field before any SQL
  (a damaged one is `BadCursor`, which the actions turn into a plain error). An older cursor names its conversation
  and is refused in any other; a sync cursor carries only the database time. The conversation always comes from
  the session (fan) or the bound page id, and `scopeFor` is applied on every read, as for `getThread`.
- `refresh` still returns the whole snapshot, for a view without `older`/`changes`.

## Known gaps

- An engine commit that applied emits `inbox.changed` on the creator channel, but the engine emits nothing on the T&S
  channel: a hard stop, a `recordFailure` escalation and a superseded hard stop reach the admin queue by the inbox poll.
- An admin holding a `human_ts` chat is not pushed the fan's new messages: the fan's send emits only on the creator
  channel, and the admin's thread does not poll while Pusher is up (read from the code, not tested).
- Message windowing: the client half is built (`lib/ui/thread-window.ts`), but no page passes `window` yet, so
  every refresh still refetches the whole snapshot.
- No `wallet.updated` yet; the wallet page reads on load.
