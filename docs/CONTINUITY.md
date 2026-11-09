# Platform continuity

Understudy runs on third parties. This is the one place that says what each one does here, how it can fail, what
the product does when it does, and what is not covered. Every provider is reached through one adapter under
`providers/` behind a port, so a fallback is another implementation of the same port and the engine does not change.

![Failover behind the ports](diagrams/continuity.html)

## Summary

| platform | used for | if it goes down | fallback | tested by |
|---|---|---|---|---|
| Instagram | collecting the creator's public posts, once, at onboarding | nothing in chat changes; onboarding a new creator waits | none needed: the persona bank is ours and chat never calls Instagram | `packages/persona/src/index.test.mjs` (the pipeline runs from the committed bank), `lib/engine/turn.db.test.ts` (a turn needs no Instagram) |
| Anthropic | writing replies and the per-fan memory; the decider fallback | replies stop unless a second model answers | `FailoverGenerator` over the primary and a fallback model; breaker per model | `providers/failover/generator.test.ts`, `providers/anthropic/generator.test.ts` |
| TypeSafe (Jev) | reading each message and verifying each draft (choice questions) | every turn fails at the first question unless another decider answers | `FailoverDecider` falls through to `ClaudeDecider` | `providers/failover/decider.test.ts`, `providers/anthropic/decider.test.ts`, `lib/engine/failover.db.test.ts` |
| Voyage | embedding the fan's message for vector retrieval | none visible: retrieval falls back to full-text | full-text search over the same chunks | `providers/voyage/persona-retriever.db.test.ts` |
| Stripe | the only way money enters: wallet top-up | fans cannot top up; spending an existing balance is unaffected | none for top-up; the ledger is internal | `lib/wallet/topup.db.test.ts`, `lib/wallet/unlock.db.test.ts` |
| Pusher | pushing "something changed" to open chats and consoles | live updates stop; the database is still the truth | clients poll and refetch | `providers/pusher/events.test.ts` |
| Neon | the only database | everything stops | none in code: restore from a Neon backup branch | `db/config-doc.test.ts` (config and seed are reproducible from the repo) |
| Resend | sign-in links by email | new sign-ins stop; signed-in sessions continue | demo seats sign in without email | `lib/auth/demo-seats.test.ts` |
| Cloudflare Turnstile | bot check on the sign-in form | sign-in is refused (fail closed) | none, by design | `lib/auth/turnstile.test.ts` |

Failure modes common to all of them: an outage, a rate limit, an account or policy termination, a price change.
A termination looks like an outage that does not end, so the fallback must be able to carry the load indefinitely;
a price change shows up in the per-turn cost the analytics already record.

## How failover works

`providers/failover/` holds the mechanism.

- `Breaker`: closed until `breaker.failures` failures land inside `breaker.window_ms`; then open for
  `breaker.cooldown_ms` (every call skips it); then half-open, which lets one call through. A success closes it, a
  failure opens it again. The clock is injected.
- `FailoverDecider` and `FailoverGenerator` try their list in order, one breaker per entry. An entry whose breaker is
  open is skipped without a call. Only the port's outage error (`DeciderUnavailable`, `GeneratorError`) counts as an
  outage; any other error is a bug and propagates unchanged. When every entry is unavailable the last outage error
  is rethrown, so the turn fails exactly as it would with a single provider: no partial reply is sent.
- A switch logs one line: `provider: <name> unavailable (<code>), using <next>`. The code is a short machine code,
  never a response body, because a body can echo fan text.

The failover wrappers are built once per server instance and reused across requests, so a breaker's failure count
survives from one turn to the next; a cold instance starts with every breaker closed.

The wiring is in `defaultDeps` (`lib/engine/deps.ts`). Models and breaker thresholds are config rows:
`model.decide_fallback`, `model.generate_fallback`, `breaker.failures`, `breaker.window_ms`, `breaker.cooldown_ms`
(see [CONFIG.md](CONFIG.md)).

## Instagram

- **What it does here.** Onboarding only: the scraper collects the creator's own public posts and replies into the
  persona bank. Chat never calls Instagram.
- **How it fails.** The unofficial web endpoints change or block the collector; the account is rate limited or
  restricted.
- **What happens today.** Nothing in chat is affected. The bank is committed (`data/persona/bank/`), the card is a
  database row, and retrieval reads the `persona_chunks` table, so a running creator keeps working.
- **Fallback and test.** None is needed for running creators. `packages/persona/src/index.test.mjs` runs the pipeline
  from the committed bank, and `lib/engine/turn.db.test.ts` runs turns with no Instagram dependency at all.
- **Not covered.** Onboarding a new creator while the collector is blocked. The step that covers it is accepting a
  creator-supplied export, which the pipeline's raw-export stage already reads.

## Anthropic (Claude)

- **What it does here.** Writes Juno's replies (`AnthropicGenerator`), updates per-fan memory, and, as
  `ClaudeDecider`, is the decider fallback.
- **How it fails.** Outage or overload (HTTP 5xx, 529), rate limit (429), account or policy termination (401/403
  that does not clear), or a price change.
- **What happens today.** `FailoverGenerator([primary model, fallback model])` in `defaultDeps`
  (`lib/engine/deps.ts:defaultDeps`). The fallback is a second model on the same vendor
  (`model.generate_fallback`), reached by the same adapter with the model replaced. When both fail the turn fails and
  is recorded as an error turn; the conversation stays in AI mode and the failure count hands over to a human at the
  limit (`lib/engine/turn.ts`).
- **Tests.** `providers/failover/generator.test.ts` (fall-through, open breaker skipped, all-down rethrow, bug
  propagation); `lib/engine/failover.db.test.ts` (a turn completes through the fallback).
- **Not covered.** A vendor-wide Anthropic loss: the second model shares the account and the outage. A second
  generator vendor slots in as another `Generator` in the list; it is not built because it needs a new account and a
  new dependency. The fallback model's price rows are seeded, but the turn prices a draft at the configured generate model's
  rate because the generator result carries no model name and the engine reads none; this under-states cost while
  the fallback serves. Closing it means the generator result exposing the serving model and the engine pricing it.
  Sonnet 5.5 takes a different request field to turn thinking off than Haiku 5.5, and `thinkingOff` in
  `providers/anthropic/generator.ts` chooses it by model id.

## TypeSafe (Jev)

- **What it does here.** The decider on the hot path: reads each inbound message (intent, safety, pitch fit),
  picks offers and verifies each draft, all as choice questions (`TypeSafeDecider`).
- **How it fails.** Outage (timeout, 5xx), rate limit (429 and 529 retry once, then fail), account termination, a
  model retirement, or a price change.
- **What happens today.** `FailoverDecider([Jev, ClaudeDecider])`. When Jev is unavailable the same questions go to
  Claude (`model.decide_fallback`) as one forced tool call whose input has one enum property per question, so the
  answer is always one of the listed option keys. The verify question is answered, not skipped. When both are down the
  turn fails as it always has: an error turn that keeps what it learned, and the third failure in a row hands over to
  the creator (`lib/engine/turn.db.test.ts`, "the decider down").
- **What changes while Claude serves.** Claude is asked for a choice and a probability for every option, normalised
  to sum to 1 (`providers/anthropic/decider.ts`). The safety floors (`floor.safety.*`), the intent floor and
  `pitch.fit_floor` stay graded: a borderline "yes" at 0.4 reaches the floors as 0.4 and stops the conversation when
  the floor is at or below it. The numbers are the model's own estimates and are not calibrated against Jev's, so the
  same message can land on either side of a floor depending on which decider answered. A choice that is not within
  0.05 of its highest-probability option, or any missing, non-numeric or negative probability, is rejected as
  malformed and the turn falls through as an outage. `floor.buy_intent_runner_up` is switched off by its default of 1.
  The model for this fallback must accept a forced tool choice, so Sonnet 5.5, Opus 5.5 and Fable 5.1 are refused at
  construction; use `claude-haiku-5-5`.
- **Tests.** `providers/anthropic/decider.test.ts` (forced tool, option mapping, every failure is a short code, no fan
  text in an error); `providers/failover/decider.test.ts`; `lib/engine/failover.db.test.ts` (Jev down, turn completes,
  the safety question is answered).
- **Not covered.** Floors tuned for the fallback. The step is running `npm run eval:engine` with the fallback decider
  serving and adjusting the floors it needs.

## Voyage

- **What it does here.** Embeds the fan's message so retrieval can find the nearest of Juno's real replies.
- **How it fails.** Outage, rate limit, key revocation.
- **What happens today.** `PersonaRetriever` catches any failure of the vector or hybrid strategy, logs
  `retrieval: <strategy> failed (<class>), falling back to fts`, and returns the full-text result for the same query
  (`providers/voyage/persona-retriever.ts:retrieve`). Chunks were embedded once at load time, so only the query
  needs Voyage.
- **Test.** `providers/voyage/persona-retriever.db.test.ts`, "a Voyage failure falls back to full-text and is logged".
- **Not covered.** Re-embedding the corpus if Voyage disappears for good: full-text is the standing strategy then
  (`retrieval.strategy` = `fts`).

## Stripe

- **What it does here.** The only path money enters. A top-up creates a Checkout session or payment intent; the signed
  webhook credits the wallet (`lib/wallet/topup.ts`, `app/api/webhooks/stripe/route.ts`).
- **How it fails.** Outage, webhook delivery delay, account termination or a processor policy change. Adult-adjacent
  content is a category payment processors review closely, so termination is a real risk, not a remote one.
- **What happens today.** Balances and unlocks are an internal prepaid ledger. After a top-up credits, spending
  (unlocks, tips) reads and writes the ledger only and never calls Stripe. If Stripe is down, fans cannot add funds
  and nothing else changes. Webhooks are idempotent, so a delayed redelivery credits once.
- **Tests.** `lib/wallet/topup.db.test.ts` (the same event applied twice credits once);
  `lib/wallet/unlock.db.test.ts` (unlocks charge the ledger).
- **Seam for a second processor.** `StripeProvider` in `providers/stripe.ts` is the type the top-up path depends on;
  a second processor implements it and a webhook route that calls the same credit function.
- **Not covered.** A second processor is not built (new vendor account). Money already in balances cannot be paid out
  or refunded through Stripe once the account is gone; that needs a manual process agreed with the processor on
  closure.

## Pusher

- **What it does here.** Tells open chats and consoles that something changed. It never carries message bodies; the
  database is the truth and the client refetches.
- **How it fails.** Outage or key revocation.
- **What happens today.** Without Pusher keys, or when an event is overdue, `useRealtime`
  (`components/chat/use-realtime.ts`) polls the same refetch on an interval. A failed emit is logged and
  never thrown (`lib/engine/turn.ts:emitDelivery`), so a Pusher outage does not fail a turn.
- **Test.** `providers/pusher/events.test.ts` (keys come from the environment only when all four exist; the adapter
  sends ids only, so a client that never hears an event loses nothing).
- **Not covered.** Typing indicators are push-only and simply stop.

## Neon

- **What it does here.** The single Postgres database: ledger, conversations, config, persona chunks.
- **How it fails.** Regional outage, account loss, accidental data loss.
- **What happens today.** Everything stops; there is no second database. The one coupling is the connection string
  (`DATABASE_URL`, read in `db/client.ts`), so recovery is a restore to a new Neon branch or project and a changed
  string.
- **Test.** `db/config-doc.test.ts` proves configuration is reproducible from the repo (seed and documented defaults
  agree); the schema is reproducible from `drizzle/`.
- **Not covered.** No tested restore drill and no hot standby. The step is a scheduled restore into a scratch branch.

## Resend

- **What it does here.** Sends the one-tap sign-in link.
- **How it fails.** Outage, domain reputation problems, account termination.
- **What happens today.** New sign-ins by email stop; existing database sessions keep working. Demo seats sign in
  with a password check and no email (`lib/auth/demo-seats.ts`).
- **Test.** `lib/auth/demo-seats.test.ts`.
- **Not covered.** Another email transport behind Auth.js's provider interface is the step; it needs a new account.

## Cloudflare Turnstile

- **What it does here.** The bot check on the sign-in form, verified on the server before any email is sent
  (`lib/auth/turnstile.ts`).
- **How it fails.** Outage or key revocation.
- **What happens today.** It fails closed: a network error or non-2xx verifies as failed and sends nothing. Sign-in
  stops until it recovers; chat for signed-in fans is unaffected.
- **Test.** `lib/auth/turnstile.test.ts`, "network error fails closed".
- **Not covered.** By design there is no fallback, because opening the form when the check is down would let bots
  mail-bomb through the sign-in route.
