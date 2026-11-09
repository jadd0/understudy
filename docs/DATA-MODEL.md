# Data model

Source: `db/schema.ts` (Drizzle), migrations `drizzle/0000_*.sql` to `drizzle/0006_*.sql`. One Neon Postgres, accessed
through `@neondatabase/serverless` with a WebSocket `Pool` so transactions are interactive.
Conventions (AGENTS.md): ids are `uuid default gen_random_uuid()`; timestamps are `timestamptz`; money is
integer cents in `_cents` columns; every top-level creator-owned row carries `creator_id` (child rows of a
conversation, `messages`, `turns`, `offers` and `handoffs`, and `unlocks` reach their creator through a foreign key;
`ledger_entries.creator_id` is null for a top-up); lock order is conversation, then wallet. The first migration creates the `vector` and `pg_trgm` extensions.

Every table is read and written by built code. Later migrations added the wallet columns (`0001`), the engine
columns (`0002`), the `grant` ledger kind (`0003`), `uncredited_payments` and the append-only trigger (`0004`),
`fan_typing_until` (`0005`) and the simulator tables (`0006`).

## Enums

`role` (fan, creator, admin) · `chunk_source` (caption, comment_reply, card) · `conversation_mode` (ai,
handoff_creator, human_creator, handoff_ts, human_ts, closed) · `sender` (fan, ai, creator, admin,
system) · `message_status` (sent, superseded, blocked) · `handoff_queue` (creator, ts) · `handoff_status`
(open, claimed, resolved) · `catalogue_kind` (ppv, bundle, personal) · `offer_status` (open, accepted,
declined, expired) · `ledger_kind` (topup, unlock, tip, refund, grant) · `handoff_reason` (minor, self_harm, threat,
location_offplatform, payment_dispute, hardship_escalation, explicit_live_chat, custom_request, unsure,
verify_failed, high_value_alert, engine_error) · `turn_route` (reply, offer, hold_creator, hard_stop, deflect,
ai_disclosure).

## Identity

| table | column | purpose |
|---|---|---|
| `users` | id, name, email (unique), email_verified, image | Auth.js adapter shape |
| | role | fan, creator or admin; default fan |
| | dob | date of birth, written once at onboarding |
| | adult_confirmed_at | set when a fan confirms 18+; written once |
| | is_sim | marks agentic simulator fans |
| | flagged_at, flag_reason | account block (for example `under_18_declared`) |
| `accounts` | user_id, type, provider, provider_account_id, tokens | Auth.js; pk (provider, provider_account_id); cascades from users |
| `sessions` | session_token (pk), user_id, expires | database sessions; cascades from users |
| `verification_tokens` | identifier, token, expires | one-time sign-in tokens; pk (identifier, token) |
| `creators` | user_id (unique), handle (unique), display_name | the creator profile for a user; `ai_enabled` is the global AI switch |
| `config` | key, creator_id (null = platform), value (jsonb), updated_at | model ids, prices, floors; read through `getConfig`, which throws if missing |

## Persona

| table | column | purpose |
|---|---|---|
| `persona_cards` | creator_id, version, body, never_list (text[]), published_at | the card the engine reads and Juno edits |
| `persona_chunks` | creator_id, source, source_url, text, meta | retrieval corpus from `data/persona/bank/chunks.jsonl`; source caption, comment_reply or card |
| | embedding | `vector(1024)`, null until embedded; HNSW index, cosine |
| | tsv | `tsvector` generated from `to_tsvector('simple', text)`; GIN index; the Postgres full-text side of the retrieval eval |
| `fan_memory` | creator_id, fan_id, profile (jsonb), version | rolling per-fan profile; pk (creator_id, fan_id) |

## Conversation

| table | column | purpose |
|---|---|---|
| `conversations` | creator_id, fan_id | one thread per creator and fan |
| | mode | who is answering: ai, handoff to a queue, human on a queue, closed |
| | version, lease_token, lease_until | compare-and-set and lease for the turn; a takeover bumps `version` |
| | fan_typing_until | set to now + 3 s by the fan composer's ping (fan-scoped, conversation from the session); the engine holds a turn while it is in the future; cleared when he sends |
| | ai_enabled | per-conversation AI switch |
| | last_pitch_at | written when the engine makes an offer; read nowhere (pacing counts from `offers`) |
| | pitch_declines | unused since the engine; declines are counted from `offers` |
| | no_pitch_until | no offers before this time (set by hardship) |
| | failed_turns | engine failures in a row; reset by a committed turn; at `engine.max_attempts` the conversation goes to Juno |
| `messages` | conversation_id, sender, sender_user_id, body, sort_at (generated), updated_at (trigger) | the transcript; DB is the truth; sort_at and updated_at drive windowed reads |
| | offer_id | offer attached to the message |
| | status | sent, superseded (stale reply after takeover), blocked |
| | client_msg_id (unique) | client-generated id so a retried send is not duplicated |
| | turn_id | the turn that answered (or a hand-back sentinel that retired) this message; null means waiting |
| | suggested | a held draft for the creator; stored with status `blocked`, never shown to the fan |
| | deliver_at | the fan sees the message once this has passed; null means at once |
| `turns` | conversation_id, inbound_ids | one row per AI turn and the messages it answers |
| | attempts, handoff_id, ms_total | draft attempts in the turn; the handoff it opened or touched; first inbound to commit |
| | jev_in, route, offer_id, draft, jev_out, outcome | the audit trail of the pipeline |
| | persona_version, models, tokens, cost_micros, ms_jev_in, ms_gen, ms_jev_out | cost and latency for analytics |
| `handoffs` | conversation_id, queue, reason, status | a request for a human: Juno or Trust & Safety |
| | claimed_by, opened_at, claimed_at, resolved_at | who took it and when |

## Money

| table | column | purpose |
|---|---|---|
| `catalogue_items` | creator_id, kind, title, teaser, price_cents, active | what can be offered; prices are seeded and edited by the creator in console settings, never model text |
| `offers` | conversation_id, item_id, price_cents, expires_at, status, turn_id, created_at, resolved_at | a priced, expiring offer made by the engine (with `turn_id`) or by the creator from her console (no `turn_id`); the price is copied from the catalogue |
| `wallets` | fan_id (pk), balance_cents | stored balance |
| | daily_cap_cents, pending_cap_cents, pending_cap_at, updated_at | the fan's own daily cap (null means the platform default) and a raise waiting for `pending_cap_at` |
| `ledger_entries` | fan_id, creator_id, kind, amount_cents | append-only record of top-ups, unlocks, tips, refunds and the welcome grant |
| | stripe_event_id (unique), stripe_session_id (unique when set), offer_id | Stripe event and Checkout session for idempotency; the offer unlocked |
| | idempotency_key (unique), conversation_id | debits store `<fanId>:<key>`, the welcome grant `welcome:<fanId>`; the conversation an unlock or tip was made in |
| `uncredited_payments` | stripe_event_id (unique), stripe_session_id, fan_id (no fk), amount_cents, currency, reason, resolved_at | a Checkout event that credited no wallet, waiting for a person to refund it in Stripe |
| `unlocks` | fan_id, item_id, ledger_entry_id | which fan owns which item; pk (fan_id, item_id) |

## Constraints that enforce invariants

| constraint | enforces | test (`db/schema.db.test.ts`) |
|---|---|---|
| `wallets_balance_non_negative`: CHECK `balance_cents >= 0` | the database refuses an overdraft even if code is wrong | rejects negative, accepts zero |
| `wallets_caps_positive`: CHECK `daily_cap_cents > 0 and pending_cap_cents > 0` | a fan's cap is never zero or negative | none |
| `handoffs_one_unresolved_per_conversation`: unique index on `conversation_id` where `status <> 'resolved'` | at most one open or claimed handoff per conversation, so two actors cannot both raise one | a second unresolved row fails; a resolved one does not |
| `ledger_entries.idempotency_key` unique | the welcome grant (`welcome:<fan id>`) and a repeated debit land once | duplicate is a no-op |
| `ledger_entries.stripe_event_id` unique | a redelivered Stripe webhook cannot credit twice; nulls may repeat | duplicate fails; nulls repeat |
| `ledger_entries.stripe_session_id` unique where not null | one Checkout session credits once, whatever event ids carry it | second credit is a no-op |
| `ledger_entries_sign_by_kind`: CHECK topup, refund, grant `> 0`; unlock, tip `< 0` | the sign always matches the kind | wrong sign refused (`ledger.db.test.ts`) |
| `ledger_entries_append_only`: BEFORE UPDATE OR DELETE trigger | the ledger only grows; test cleanup uses TRUNCATE, which row triggers do not see | update and delete refused (`ledger.db.test.ts`) |
| `unlocks` pk (`fan_id`, `item_id`) | a fan can unlock an item once | duplicate fails |
| `config_key_creator_unique`: unique (`key`, `creator_id`) NULLS NOT DISTINCT | one platform row per key, because creator_id null would otherwise never collide | see `lib/config.db.test.ts` for the lookup order |
| `catalogue_items_price_positive`: CHECK `price_cents > 0` | no free or negative priced item | rejects zero |
| `conversations_creator_fan_unique` | one conversation per creator and fan | duplicate fails |
| `persona_cards_creator_version_unique` | one row per card version | none |
| `messages.client_msg_id` unique | idempotent send | none |
| `creators.user_id`, `creators.handle` unique | one creator profile per user; unique handles | none |

The balance-equals-ledger-sum invariant is asserted by the wallet tests (`assertBalanceEqualsLedger` in
`lib/wallet/test-helpers.ts`), not by the schema.

## Test database

Tests never touch the dev database. `vitest.global-setup.ts` calls `scripts/test-db.mjs`, which creates
`<db>_test_<branch-slug>` in the same Neon project if absent (the slug is the lower-cased branch name,
non-alphanumerics collapsed to `_`, at most 40 characters; override with `TEST_DB_BRANCH`), applies
`drizzle/`, and returns its URL. Global setup refuses to proceed unless the name contains `_test_`, then
truncates every table except `__drizzle_migrations` and points `DATABASE_URL` at it. Parallel branches
therefore never share test data while sharing one Neon project. Dev and demo use `neondb`.
