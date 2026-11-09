# Scaling

How the data model behaves as creators and conversations grow, from measurements rather than claims. Every number
below comes from `docs/scaling/explain.json` (the plans after the one index added here) and
`docs/scaling/explain.before-index.json` (the plans before it). To reproduce them, see `scripts/scale/README.md`.

## Measured volume

One Postgres 18 database on Neon, seeded by `scripts/scale/seed-volume.ts`:

| table | rows |
|---|---|
| creators | 200 |
| conversations | 20,000 (100 fans per creator) |
| messages | 1,000,000 (50 per conversation) |
| turns | 499,600 |
| offers | 8,000 |
| persona chunks | 8,000 (40 per creator, with 1024-dimension embeddings) |
| handoffs | 200 (open) |
| staff messages | 5,986 across 2,000 conversations (one in ten had a takeover, 1 to 5 replies each, one in four of them by an admin) |

Message bodies in the seed are short (about 60 characters) and the turn rows carry small `jsonb` records, so the
byte figures below are a floor: real replies and the full Jev and token records make rows larger.

## 1. What scales with what

Each fan message that gets a reply writes, in the engine's tables:

- 1 `messages` row for the fan's message and 1 for the reply (a reply split into several bubbles writes one per bubble)
- 1 `turns` row, carrying the Jev answers, the draft, the models, the tokens and the cost
- on a pitch, 1 `offers` row; on a handoff, 1 `handoffs` row (at most one unresolved per conversation)
- 1 `fan_memory` row per fan and creator, updated in place

Measured size on disk, heap and indexes together: `messages` 352 MB for 1,000,000 rows (369 bytes per row, of which
182 MB is indexes), `turns` 192 MB for 499,600 rows (402 bytes per row), `persona_chunks` 66 MB for 8,000 rows
(8.6 kB per row, almost all of it the embedding and its index).

Storage per creator per month, at a stated rate of 100 active fans who each send 100 messages a month: 10,000 fan
messages, 10,000 replies and 10,000 turns, which is 20,000 x 369 + 10,000 x 402 = about 11.4 MB per creator per
month at the seed's row shape. `persona_chunks` is a one-off per creator, about 340 kB for 40 chunks. Everything
grows with fan messages. Nothing grows with the number of creators except these per-creator totals.

## 2. Hot paths

Each row is the SQL the code sends: the script calls the real function once while the driver records the
statement, then runs that statement under `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` 20 times after one warm-up. The
ids are real ones from the seed. Times are Postgres execution time in milliseconds on the seeded volume, with a warm
cache.

| hot path | p50 / p95 ms | rows | plan |
|---|---|---|---|
| lease claim | 0.10 / 0.10 | 1 | primary key on `conversations` |
| inbound load (unanswered fan messages for one conversation) | 0.06 / 0.06 | 1 | `messages_unanswered_idx`, `messages_staff_sent_idx` |
| facts (offer history, declines in window, velocity) | 0.17 / 0.19 | 1 | `offers_conversation_idx`, `turns_conversation_idx`, `messages_conversation_created_idx` |
| published card read | 0.04 / 0.04 | 1 | `persona_cards_creator_version_unique` |
| chat history (last 600 rows of one conversation) | 0.13 / 0.15 | 50 | `messages_conversation_updated_idx` |
| retrieval, full text | 0.13 / 0.15 | 6 | `persona_chunks_creator_idx`, then the text filter |
| retrieval, vector | 0.30 / 0.32 | 6 | `persona_chunks_creator_idx`, then an exact sort of the creator's chunks |
| sweep scan (stale unanswered conversations) | 4.95 / 5.99 | 10 | `messages_unanswered_idx`, `messages_staff_sent_idx`, one scan of `conversations` |
| creator inbox page (100 conversations) | 18.69 / 22.80 | 100 | `conversations_creator_fan_unique`, `messages_conversation_updated_idx` |
| handoff queue (open handoffs for one creator) | 0.14 / 0.17 | 1 | `conversations_creator_fan_unique` |

Some of these plans also scan a small table sequentially (`handoffs` and `creators` at 200 rows each,
`creator_settings` at none), under the 10,000-row line the script uses to flag a scan.

The per-turn paths (lease, inbound, facts, card, history, retrieval) add up to under 1 ms of database time, so a turn's
latency is the providers (section 6). The two paths that cost milliseconds are the sweep, which runs once a
minute, and the creator inbox.

Not measured: a creator with far more than 100 conversations. The inbox read has no page limit and runs three
correlated subqueries per conversation (about 0.19 ms each conversation here), so its time grows in proportion to the
conversations a creator has; a creator with thousands of fans needs a paged inbox before that read stays interactive.
The vector retrieval plan sorts all of one creator's chunks exactly rather than using the HNSW index, which is cheap
at 40 chunks and has not been measured at tens of thousands.

## 3. Indexes

The hot paths use these existing indexes:

| index | table | used by |
|---|---|---|
| `conversations_creator_fan_unique` (creator, fan) | `conversations` | inbox, handoff queue, one conversation for a creator and fan |
| `messages_conversation_created_idx`, `messages_conversation_updated_idx`, `messages_conversation_sort_idx` | `messages` | history, thread pages, change reads |
| `messages_unanswered_idx` (partial: fan messages with no turn) | `messages` | inbound load, sweep |
| `turns_conversation_idx`, `turns_created_idx` | `turns` | facts, analytics windows |
| `offers_conversation_idx` | `offers` | facts, change reads |
| `handoffs_one_unresolved_per_conversation` (partial unique) | `handoffs` | one open handoff per conversation, open-handoff checks |
| `persona_chunks_creator_idx`, `persona_chunks_tsv_gin`, `persona_chunks_embedding_hnsw` | `persona_chunks` | retrieval |
| `persona_cards_creator_version_unique` | `persona_cards` | card read |

### Added: `messages_staff_sent_idx`

The sweep scan showed a Seq Scan on `conversations` (20,000 rows, over the 10,000 line). That scan is the build side
of a hash join and costs about 2 ms of the 24; the index cannot remove it, because the planner estimates the partial
unanswered index at 250,000 rows (AI replies also have no turn, so "no turn and from a fan" looks like a quarter of
`messages`) against 400 actual, and an extended-statistics object on `sender` and `turn_id` did not change the
estimate. The cost sat elsewhere in the same plan: for each of the 400 stale conversations, the check "newest
message a creator or admin sent" read every message of that conversation through `messages_conversation_updated_idx`
(21,200 buffers touched).

`messages_staff_sent_idx` is a partial index on `(conversation_id, created_at)` for messages from a creator or admin
that were sent. With it that check is one backward index-only probe.

| plan | before | after |
|---|---|---|
| sweep scan, p50 / p95 | 24.60 / 29.81 ms | 4.95 / 5.99 ms |
| inbound load, p50 / p95 | 0.13 / 0.16 ms | 0.06 / 0.06 ms |
| Seq Scan on `conversations` in the sweep | present | still present, as the hash build |

The index holds only the messages humans sent (5,986 rows, 256 kB). A plain `CREATE INDEX` takes a write lock on
`messages` while it builds; on a table of this size apply it in a quiet window.

No other index was added: no other hot path scans a table over 10,000 rows sequentially.

## 4. Isolation

- **`creator_id` on every top-level row.** `conversations`, `persona_cards`, `persona_chunks`, `fan_memory`,
  `creator_settings`, `catalogue_items`, `ledger_entries`, `sim_runs` and `config` (null for a platform row) carry it.
  Rows that hang off a conversation (`messages`, `turns`, `offers`, `handoffs`) reach their creator through
  `conversation_id`, and `unlocks` through the catalogue item.
- **Every read is keyed by creator or by conversation.** Retrieval filters on `creator_id`; the card read filters on
  it; configuration is resolved per creator with platform-only keys read from platform rows alone; the shortlist is
  built for one creator; fan memory is keyed on (creator, fan); the inbox is scoped to the viewer's creators.
- **What the tests prove** (`packages/engine/src/isolation.db.test.ts`), with two creators and one fan who talks to
  both: a turn for one creator retrieves only that creator's chunks (full text and vector), including when the other
  creator's chunk carries the first one's id in its text; reads only that creator's published card; sees only that
  creator's configuration override, and a creator row under a platform-only key is ignored; offers only that
  creator's items even when the fan owns the other's; keeps fan memory separate for the same fan; lists only that
  creator's conversations, and a takeover by one creator's actor on the other's conversation is refused. A schema
  scan over `information_schema` fails when a table appears that is not classified as creator-keyed, conversation-keyed
  or creator-free. Removing the `creator_id` filter from retrieval turns three of these tests red.
- **Next step, designed and not built: row-level security.** If creators ever share a database with code that is not
  trusted to add the filter, enable row-level security on the creator-keyed tables with a policy on
  `current_setting('app.creator_id')`, set per transaction by the host. Today every query is written by this
  codebase and the filter is tested, so the application-level filter is the control.

## 5. Partitioning

Not built: at 1,000,000 messages every per-turn path above runs in under a millisecond, because each is keyed by
conversation and served by a conversation-leading index. The paths that grow with volume (the sweep and the inbox)
are bounded by unanswered conversations and conversations per creator, not by total rows. Partitioning is worth
building when the indexes no longer fit in memory (`messages` indexes are 182 MB at one million rows, roughly 180 GB at a
billion) or when maintenance on the whole table (a vacuum, an index build, a retention delete) becomes the problem.
The measured row count where the hot paths degrade is not reached at 1,000,000.

The design when it is needed: hash-partition `messages` and `turns` by `conversation_id` (for example 32 partitions).
Not by creator: one very large creator would put most of the rows in one partition. Every hot query already filters by
`conversation_id` (or reaches it by a join), so Postgres prunes to one partition and the code does not change. The
unique constraints that include only `id` would need the partition key added (`(conversation_id, id)`), and the
foreign keys that point at `messages` and `turns` would move to that pair; both are migration work, not application
work. Retention (dropping messages older than a window) is a separate decision that partitioning by time would serve
better and by conversation would not.

## 6. The engine's throughput limit

A turn spends its time in providers: Jev (the engine budgets about 0.6 s per verify call), Claude (about 2.6 s per
generation) and the typing delays the engine adds on purpose. Its database work is the handful of reads in the hot-path table plus one transaction
that commits the turn; together under a millisecond of query time plus the commit. The lease and the debounce make one
turn per conversation at a time, so a conversation is never processed twice at once, and concurrency across
conversations is limited by the provider rate limits and by connections, not by query time. Horizontal scale is more
app instances: the lease is taken in the database, so instances share nothing else.

## 7. Neon specifics

- **Pooling.** The host connects through Neon's pooled endpoint over the serverless driver's WebSocket `Pool`, so
  transactions are interactive (the commit and the lease logic need that). Each serverless instance holds a pool of the driver's default size;
  the total is the instance count times the pool size, which must stay under the pooler's limit.
- **Branch per test.** Tests and the volume measurement create their own database in the same project
  (`<database>_test_<branch>[_<scope>]`), apply the migrations, and are dropped when done, so measuring at a million
  rows never touches the working database. The measurement database here was dropped after the figures were written.
- **Plans.** The figures are warm-cache execution times inside Neon; a cold compute that just woke pays a one-off cost
  for the first reads, which is not in these numbers.
