# Monetisation

How a fan's money moves: the prepaid wallet, the ledger, unlocks and tips, the spending limits, and the
"high-value fan" figure. Code lives in `examples/app/lib/wallet/`; Stripe is reached only through `examples/app/providers/stripe.ts`.

## Model

- A fan **tops up a wallet** through Stripe Checkout, then **spends from it**: unlocking a catalogue item an
  offer points at, or tipping the creator. There is no per-unlock Stripe charge. One card payment funds many
  small purchases, so a fan never re-enters card details at the moment of desire, and Stripe fees apply once
  per top-up rather than once per $9.99 unlock.
- **Money is integer cents** everywhere (`*_cents`), USD only. The `/wallet` form takes dollars and converts
  once, strictly, in `examples/app/lib/wallet/money.ts`; input that is not `12`, `12.5` or `12.50` is refused.
- **The ledger is append-only.** `ledger_entries` signs are: `topup`/`refund`/`grant` positive, `unlock`/`tip`
  negative. `wallets.balance_cents` is a stored copy updated in the same locked transaction as each entry, with
  `CHECK (balance_cents >= 0)` as the last line of defence. Wallet tests assert balance = ledger sum with
  `assertBalanceEqualsLedger` (`examples/app/lib/wallet/test-helpers.ts`), called explicitly after the money paths; the database
  does not enforce the equality.
- **Every adult fan starts with $50.** The founder asked for the account to start with $50 in credits, as on the
  real platform. Completing onboarding (18+ confirmed) writes one `grant` ledger entry of
  `wallet.welcome_credit_cents` (5000) in the same transaction as the confirmation; the unique key
  `welcome:<fan id>` makes a repeat, a retry or a concurrent call grant once. A flagged or under-18 fan never
  gets it, and `db:seed` backfills fans confirmed before it existed. It is platform money, not revenue: it is
  a `grant`, not a `topup`, so revenue and top-up figures never count it, and it is spendable on unlocks and
  tips but not refundable or withdrawable.
- **Only the webhook credits real money.** The Checkout success URL shows "processing" and reads the balance; it never
  credits.

## Flows

1. **Top-up.** `/wallet` -> `startTopup` (amount is a preset, or any whole cents in
   `wallet.topup_min_cents`..`wallet.topup_max_cents`; anything else is refused before Stripe is called) ->
   Checkout Session (`mode: payment`, `price_data`, `metadata.fan_id`) -> Stripe -> `POST /api/webhooks/stripe`.
2. **Webhook.** Raw body -> signature check (`400` on failure, nothing read from the body) -> `applyCheckoutEvent`.
   `checkout.session.completed` and `checkout.session.async_payment_succeeded` with `payment_status = paid` and
   `usd` -> `credit()` with the Stripe event id and the Checkout session id. The amount is Stripe's `amount_total`
   and the fan is the session metadata, never a client value. The event id and the session id are each unique on
   `ledger_entries`, so one session credits once however many events carry it. A paid session that cannot credit
   (missing, malformed, unknown or flagged fan; non-USD; unpaid; amount not a positive whole number of cents) and
   an `async_payment_failed` event write an `uncredited_payments` row (unique on the event id, so a replay adds
   nothing) and answer `200`, so Stripe does not retry forever. There is no automatic refund: a person refunds in
   Stripe from the admin "Payments needing review" list on `/analytics`. An unpaid row is resolved by itself when
   the same session later credits. A real failure answers `500` so Stripe redelivers; the unique ids make that safe.
3. **Unlock.** `unlockOffer(fanId, offerId)`: lock the offer row, check it belongs to the caller's
   conversation, lock the wallet, return `alreadyUnlocked` if this offer is already `accepted` (a retry or a double
   tap), require `status = open` and `expires_at > now()`, debit the **offer's copied price** (not the catalogue's
   current one), insert the unlock (kept as it is when he already owns the item), mark the offer `accepted`. One
   transaction. A purchase then schedules an engine turn in which she checks in about the item (`unlockInChat`,
   `examples/app/lib/chat/react.ts`); the `alreadyUnlocked` path charges nothing and schedules nothing.
4. **Tip.** `tip(fanId, creatorId, amountCents, idempotencyKey)`: one debit; a retry with the same key
   returns the first result and charges nothing. `tipInChat` (`examples/app/lib/chat/react.ts`) adds the "You tipped $X" system
   row (unique per key) and, only when it wrote that row, schedules a turn in which she thanks him; the model is told
   "he sent you a tip", never the amount.

## Races and what stops each

| Race | Guard | Test |
|---|---|---|
| Same offer unlocked twice at once | offer row lock, then wallet lock; `(fan_id, item_id)` primary key on `unlocks` | `races.db.test.ts` 1, 3 |
| Two offers, money for one | wallet row `FOR UPDATE` serialises; `debit()` checks the locked balance; CHECK as backstop | 2, 7 |
| Stripe redelivers the webhook | unique `ledger_entries.stripe_event_id`; insert-or-no-op | 4 |
| Two event ids for one Checkout session (completed + async succeeded) | unique `ledger_entries.stripe_session_id`; the wallet lock serialises, the loser is a no-op | `topup.db.test.ts` |
| Ledger row edited or removed, or the wrong sign for its kind | CHECK `ledger_entries_sign_by_kind`; trigger `ledger_entries_append_only` refuses UPDATE and DELETE | `ledger.db.test.ts` |
| Client retries a tip | unique `ledger_entries.idempotency_key` (stored `fanId:key`) | 5 |
| Several debits that each fit the cap but not together | the cap check runs under the wallet lock | 6 |

**Lock order** is conversation, then offer, then wallet, then user. `unlockOffer` share-locks the offer's
conversation, then locks the offer, then the wallet, then share-locks the user row (`assertFanMaySpend`); `tip`
share-locks its conversation (when it has one), then the wallet, then the user row. Config is read
before a transaction opens: a transaction that waits for a second pooled connection can exhaust the pool.

## Spending limits

- **Platform default** `wallet.daily_cap_cents` (20000). A fan's own cap (`wallets.daily_cap_cents`)
  overrides it. Spend counts unlock and tip debits since 00:00 UTC; a debit that would pass the cap is
  refused with `CapReached`.
- **The fan sets their own cap** on `/wallet`, minimum `wallet.cap_min_cents` (500). **Lowering applies
  immediately. Raising applies after `wallet.cap_raise_delay_hours` (24).** The raise waits in
  `pending_cap_cents`/`pending_cap_at` and is applied lazily the first time the cap is read afterwards, under
  the wallet lock. This is the cooling-off pattern from responsible-gambling practice: a fan in the moment
  cannot lift their own limit. Lowering again cancels a pending raise.

- **Ceiling.** A fan's own cap may not exceed `cap.max_daily_cents` (100000, $1,000); above it `setFanCap`
  throws `InvalidAmount`. Without a ceiling a fan could set a cap no one would call a limit. The founder can
  change the row.

## Who may spend

- Only a fan whose account is not flagged may unlock or tip. Role and `flagged_at` are read inside the
  transaction, after the wallet lock, with a share lock on the user row, so a flag written mid-flight either
  is seen or waits. A creator, an admin or a flagged fan gets `NotAllowed` and nothing is written.
- An offer for an item the fan already owns (a re-offer when nothing new is left) is paid again like any purchase:
  its own ledger entry, the offer `accepted` and counted as a conversion, while ownership stays the one `unlocks`
  row (unique on fan and item) from the first purchase. Only a repeat of an already accepted offer charges nothing.
- A tip needs an existing creator, and a `conversationId`, when given, must be this fan's conversation with
  that creator; otherwise `NotFound`.

## High-value fan

`highValueScore(fanId, creatorId)` = sum over the fan's debits to that creator of
`amount * 0.5^(age_days / half_life_days)`, computed in SQL at read time from the ledger, never stored as a
counter. `isHighValue` is score >= `fan.high_value_threshold_cents`. Half-life and threshold are config rows
(`fan.high_value_half_life_days` 7, `fan.high_value_threshold_cents` 10000). A half-life that is not a positive
finite number throws `ConfigInvalid` rather than dividing by it.

## Config keys

`wallet.topup_options_cents`, `wallet.topup_min_cents`, `wallet.topup_max_cents`, `wallet.daily_cap_cents`,
`wallet.cap_min_cents`, `cap.max_daily_cents`, `wallet.cap_raise_delay_hours`, `fan.high_value_threshold_cents`,
`fan.high_value_half_life_days`, `offer.ttl_minutes`, `wallet.welcome_credit_cents`, `wallet.tip_options_cents`,
`wallet.tip_min_cents`. Seeded values are demo placeholders. The tip minimum is enforced in `tipAction`
(`examples/app/app/chat/actions.ts`), not in `tip()`, so the fan simulator's tips skip it.

## Pitch pacing

The engine may put an offer in front of a fan only when `canPitch` (`packages/engine/src/pacing.ts`) allows, checked in this
order: no active hardship cooldown (`pitch.hardship_cooldown_hours`); fewer than `pitch.max_declines` declines in
`pitch.decline_window_minutes`; not at the daily cap; fewer than `pitch.velocity_max_unlocks` unlocks in
`pitch.velocity_window_minutes`; and at least `pitch.min_gap_rounds` rounds since the last offer (skipped for a buy
intent or an explicit request). The facts are read in `packages/engine/src/facts.ts`. The cap is one rule, `capAllows` in
`examples/app/lib/wallet/cap.ts` (spend today plus the amount within the cap): the debit refuses what it refuses, and the engine's
shortlist drops every item whose price it refuses, so the AI never pitches an item the cap would then refuse. The `pitch.*` keys can be overridden per creator; only `floor.*` and `platform.*` rows are platform-only.
Juno's own offers from the console skip pacing. Full routing: `docs/APP.md` §8.6.

## Not built, and partly built

**Creator payouts (Stripe Connect)** are the production next step: onboard the creator as a connected account,
and pay out from platform balance on a schedule, recording each payout as a ledger entry. It is documented
here and deliberately not built. Refund entries exist in the ledger kind enum; no refund flow is built.

**Saved-card top-up (PaymentIntent): built, used only by the fan simulator.** `startTopupIntent(fanId, amountCents, paymentMethod)` validates the amount exactly like
`startTopup`, then creates a confirmed PaymentIntent (`currency usd`, `payment_method`, redirect methods off,
`metadata.fan_id`, `metadata.purpose = wallet_topup`). The same webhook route dispatches `payment_intent.succeeded` to
`applyPaymentIntentSucceeded`: only `purpose = wallet_topup` in `usd` counts, the amount is `amount_received`, the fan is
the metadata, the Stripe event id is the ledger key (a redelivery is a duplicate), and an unknown or flagged fan is
ignored. The fan simulator tops up this way with `pm_card_visa` (FAN-SIM.md section 7); a production "saved card" button
would use the same two functions. Unlike Checkout, a PaymentIntent that cannot credit writes no `uncredited_payments`
row, only a log line.
