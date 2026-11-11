# Configuration

Every tunable value in the product, in one place. There are two kinds.

1. **Config rows** (the `config` table). Floors, ceilings, round counts, timings, model ids and prices. The app reads
   them at runtime through `getConfig(key, creatorId?)` (`examples/app/lib/config`), which throws `ConfigMissing` instead of falling
   back to a default, so a missing row stops the feature rather than guessing. A row can be set per creator (the
   `creator_id` column) or platform-wide (null).
2. **Code constants.** Client and server timings that are part of how a screen behaves, not product policy. Changing one
   is a code change and a deploy.

`examples/app/db/config-doc.test.ts` fails the gate if a config row or one of the constants below is missing from this file or its
default here differs from the code.

## Changing a value

- **A running database:** update the row. Nothing restarts; the next read sees it.

  ```sql
  update config set value = '0.55'::jsonb where key = 'floor.intent' and creator_id is null;
  ```

- **New databases:** change the default in `examples/app/db/seed.ts` (the four `*_CONFIG` objects) and in the table below. A re-seed
  never overwrites a row that already exists, so an edited value survives `npm run db:seed`.
- **A release that adds a row:** the engine reads every row it needs and throws `ConfigMissing` for one that is absent, so a
  database that predates the row must be seeded before the new engine serves it. `npm run db:seed` adds only the missing rows
  (the row `floor.offplatform_on_buy` is the latest); run it on each database first, or every turn fails closed.
- **A code constant:** edit it in the file named in its row, and the row here.

Money is integer cents (`_cents`), costs are integer micro-dollars (`_micros`), prices are micro-dollars per million
tokens (`_per_mtok`). Times carry their unit in the name.

## Config rows

### Wallet, caps and offers

| key | default | what it does | read in |
|---|---|---|---|
| `wallet.topup_options_cents` | `[1000,2500,5000]` | the top-up amounts offered on /wallet | `examples/app/lib/wallet/topup.ts`, `examples/app/app/wallet/page.tsx` |
| `wallet.topup_min_cents` | `500` | smallest custom top-up | `examples/app/lib/wallet/topup.ts` |
| `wallet.topup_max_cents` | `50000` | largest custom top-up | `examples/app/lib/wallet/topup.ts` |
| `wallet.welcome_credit_cents` | `5000` | credit granted once when a fan confirms 18+ | `examples/app/lib/wallet/grant.ts` |
| `wallet.tip_options_cents` | `[200,500,1000]` | the tip amounts in the chat's tip sheet | `examples/app/app/chat/page.tsx` |
| `wallet.tip_min_cents` | `100` | smallest custom tip | `examples/app/app/chat/actions.ts` |
| `wallet.daily_cap_cents` | `20000` | platform daily spend cap for a fan who has not set their own | `examples/app/lib/wallet/cap.ts` |
| `wallet.cap_min_cents` | `500` | floor on the cap a fan may set | `examples/app/lib/wallet/cap.ts` |
| `cap.max_daily_cents` | `100000` | ceiling on the cap a fan may set | `examples/app/lib/wallet/cap.ts` |
| `wallet.cap_raise_delay_hours` | `24` | a raised cap takes effect after this; a lowered one is immediate | `examples/app/lib/wallet/cap.ts` |
| `fan.high_value_threshold_cents` | `10000` | decayed spend at or above this makes a fan high-value (Juno gets an alert) | `examples/app/lib/wallet/score.ts` |
| `fan.high_value_half_life_days` | `7` | half-life of the spend decay in the high-value score | `examples/app/lib/wallet/score.ts` |
| `offer.ttl_minutes` | `1440` | how long an offer stays open before it expires | `packages/engine/src/config/load.ts`, `examples/app/lib/conversations/controls.ts` |

### Models and prices

| key | default | what it does | read in |
|---|---|---|---|
| `jev.model` | `"jev-1.14.0"` | the classifier for inbound reading and verify | `packages/engine/src/config/load.ts` |
| `model.generate` | `"claude-haiku-5-5"` | writes Juno's replies | `packages/engine/src/config/load.ts` |
| `model.memory` | `"claude-haiku-5-5"` | updates the per-fan memory | `packages/engine/src/config/load.ts` |
| `model.decide_fallback` | `"claude-haiku-5-5"` | answers the choice questions when Jev is unavailable | `examples/app/lib/host/deps.ts` |
| `model.generate_fallback` | `"claude-sonnet-5-5"` | writes the reply when `model.generate` is unavailable | `examples/app/lib/host/deps.ts` |
| `breaker.failures` | `3` | failures inside the window that open a provider's circuit breaker | `examples/app/lib/host/deps.ts` |
| `breaker.window_ms` | `60000` | the window those failures are counted in | `examples/app/lib/host/deps.ts` |
| `breaker.cooldown_ms` | `30000` | how long an open breaker skips its provider before letting one call through | `examples/app/lib/host/deps.ts` |
| `gateway.generate.enabled` | `false` | sends drafts and memory calls through llm-gateway first, Claude direct behind it; a platform row (a creator's row is ignored) | `examples/app/lib/host/deps.ts` |
| `gateway.decide.enabled` | `false` | sends the choice questions through llm-gateway first, Jev and Claude behind it; a platform row (a creator's row is ignored) | `examples/app/lib/host/deps.ts` |
| `gateway.decide_model` | `"gpt-5-mini"` | the model the gateway is asked for the choice questions: it must route to an OpenAI-format upstream, because the gateway refuses tools on its Anthropic and Gemini routes | `examples/app/lib/host/deps.ts` |
| `gateway.key_env` | `"GATEWAY_KEY"` | the name of the environment variable that holds the gateway key; set it per creator to give that creator their own gateway tenant | `packages/providers/src/gateway/keys.ts` |
| `gateway.timeout_ms` | `30000` | how long one gateway call may take before it counts as a failure and the next provider is tried | `examples/app/lib/host/deps.ts` |
| `price.claude-haiku-5-5.input_per_mtok` | `100000` | input price, for turn cost | read as `price.<model>.*` in `packages/engine/src/config/load.ts` |
| `price.claude-haiku-5-5.output_per_mtok` | `500000` | output price | as above |
| `price.claude-haiku-5-5.cache_read_per_mtok` | `10000` | cache read price | as above |
| `price.claude-haiku-5-5.cache_write_per_mtok` | `125000` | 5-minute cache write price | as above |
| `price.claude-sonnet-5-5.input_per_mtok` | `2000000` | input price of the generator fallback model | as above |
| `price.claude-sonnet-5-5.output_per_mtok` | `10000000` | output price | as above |
| `price.claude-sonnet-5-5.cache_read_per_mtok` | `200000` | cache read price | as above |
| `price.claude-sonnet-5-5.cache_write_per_mtok` | `2500000` | 5-minute cache write price | as above |
| `price.jev-1.14.0.input_per_mtok` | `42000` | Jev input price | as above |
| `price.jev-1.14.0.output_per_mtok` | `0` | Jev output tokens are free | as above |

A new model needs its four (Claude) or two (Jev) price rows, or turn cost throws `ConfigMissing`.

### Engine: rounds, timing, delivery

| key | default | what it does | read in |
|---|---|---|---|
| `engine.history_rounds` | `20` | rounds of chat Claude sees when writing a reply | `packages/engine/src/config/load.ts` |
| `engine.jev_context_rounds` | `6` | rounds of earlier chat Jev sees when classifying | `packages/engine/src/config/load.ts` |
| `engine.max_tokens` | `300` | output cap for one reply | `packages/engine/src/config/load.ts` |
| `engine.gen_attempts` | `2` | drafts per turn before the reply is held as a suggestion for Juno | `packages/engine/src/config/load.ts` |
| `engine.max_attempts` | `3` | failed turns in a row before the chat goes to Juno (`engine_error`) | `packages/engine/src/config/load.ts` |
| `engine.debounce_ms` | `250` | wait after a fan message before the turn starts, so a burst is read together | `packages/engine/src/config/load.ts`, `packages/engine/src/conversation/sweep.ts` |
| `engine.debounce_max_ms` | `8000` | longest the turn waits while the fan is still typing | `packages/engine/src/config/load.ts` |
| `engine.turn_budget_ms` | `12000` | a still-typing wait or a fold-in only starts while the turn is younger than this | `packages/engine/src/config/load.ts` |
| `engine.fold_in_max` | `1` | times a late fan message may restart a turn | `packages/engine/src/config/load.ts` |
| `engine.lease_ms` | `30000` | a turn running longer can be re-leased and loses its commit | `packages/engine/src/config/load.ts` |
| `engine.gap_marker_minutes` | `30` | a silence this long gets a time marker and counts as a new session | `packages/engine/src/config/load.ts` |
| `engine.typing_cps` | `12` | typing speed used to time the first bubble (characters per second) | `packages/engine/src/config/load.ts` |
| `engine.typing_max_ms` | `10000` | cap on the first bubble's typing wait | `packages/engine/src/config/load.ts` |
| `engine.event_window_minutes` | `60` | a tip or unlock older than this gets no reaction from her; also bounds rows written before reactions existed | `packages/engine/src/config/load.ts`, `packages/engine/src/conversation/events.ts` |
| `engine.offer_history_count` | `5` | offers from this chat (latest per item) Claude is told the outcome of | `packages/engine/src/config/load.ts` |
| `delivery.bubble_gap_ms_min` | `1500` | shortest gap between her bubbles | `packages/engine/src/config/load.ts` |
| `delivery.bubble_gap_ms_max` | `4000` | longest gap between her bubbles | `packages/engine/src/config/load.ts` |
| `platform.support_email` | `"support@understudy.example"` | the address in support and dispute replies | `packages/engine/src/config/load.ts` |
| `escalation.creator_sla_minutes` | `30` | a creator-queue handoff's due time after it opens; the creator's queue row shows it | `packages/engine/src/config/load.ts`, `examples/app/lib/conversations/read.ts` |
| `escalation.ts_sla_minutes` | `15` | a Trust & Safety handoff's due time; past it the sweep stamps the breach and alerts, and never resolves it | `packages/engine/src/config/load.ts` |
| `escalation.auto_resolve_reasons` | `["unsure","verify_failed","custom_request","explicit_live_chat","high_value_alert"]` | creator-queue reasons the sweep may settle by policy once due and unclaimed; any other reason (such as `engine_error`) waits for a person | `packages/engine/src/conversation/escalation.ts`, `examples/app/lib/conversations/read.ts` |
| `escalation.hold_suppress_minutes` | `1440` | after the sweep settles a hold, the same chat's next hold is answered by the AI for this long | `packages/engine/src/conversation/escalation.ts` |

### Floors (Jev confidence) and pitching

A safety floor is the probability at which a Jev reading counts. At or above it the hard stop fires; below it the
message is treated as not that. The safety floors are read as `floor.safety.<key>` in `packages/engine/src/config/load.ts`.

| key | default | what it does | read in |
|---|---|---|---|
| `floor.safety.minor` | `0.3` | the fan may be under 18: hard stop, minor notice, account flagged | `packages/engine/src/config/load.ts` |
| `floor.safety.self_harm` | `0.3` | crisis: hard stop with the support message | `packages/engine/src/config/load.ts` |
| `floor.safety.threat` | `0.5` | threat or harassment: hard stop, account flagged | `packages/engine/src/config/load.ts` |
| `floor.safety.location_offplatform` | `0.5` | meetup, location, contact details or paying outside: a boundary line and a numbered warning; the `ts.max_strikes`th pauses the chat | `packages/engine/src/config/load.ts` |
| `floor.safety.payment_dispute` | `0.6` | refund or charge complaint: hard stop | `packages/engine/src/config/load.ts` |
| `floor.safety.hardship` | `0.5` | money trouble: no hard stop, pitching pauses for `pitch.hardship_cooldown_hours` | `packages/engine/src/config/load.ts`, `examples/app/lib/analytics/responsible.ts` |
| `safety.minor.enabled` | `true` | the under-18 check: asked of the decider and routed to a hard stop; `false` skips both. Platform rows only: a creator row is ignored | `packages/engine/src/config/load.ts`, `packages/engine/src/routing/questions.ts` |
| `safety.self_harm.enabled` | `true` | the crisis check: asked and routed to a hard stop with the support message; `false` skips both. Platform rows only: a creator row is ignored | `packages/engine/src/config/load.ts`, `packages/engine/src/routing/questions.ts` |
| `safety.threat.enabled` | `true` | the threat and harassment check: asked and routed to a hard stop; `false` skips both. Platform rows only: a creator row is ignored | `packages/engine/src/config/load.ts`, `packages/engine/src/routing/questions.ts` |
| `safety.location_offplatform.enabled` | `true` | the meetup and off-platform check: asked and routed to a boundary line, strike and pause; `false` skips both. Platform rows only: a creator row is ignored | `packages/engine/src/config/load.ts`, `packages/engine/src/routing/questions.ts` |
| `safety.payment_dispute.enabled` | `true` | the refund and charge-complaint check: asked and routed to a hard stop; `false` skips both. Platform rows only: a creator row is ignored | `packages/engine/src/config/load.ts`, `packages/engine/src/routing/questions.ts` |
| `floor.intent` | `0.5` | below this the intent read is "unsure" and the turn goes to Juno, unless the best guess is a buy | `packages/engine/src/config/load.ts` |
| `floor.buy_intent_runner_up` | `1` | off; at 1 nothing is promoted. Below 1: when Jev picks `smalltalk` or `flirt` but gives `buy_intent` at least this, the read is routed as `buy_intent` (recorded as `jev_in.parsed.promotedFrom`) | `packages/engine/src/config/load.ts`, `packages/engine/src/routing/route.ts` |
| `floor.offplatform_on_buy` | `0.8` | a confident buy ask (not a promoted read) whose off-platform probability is below this is offered to instead of struck; at or above it strikes as before. The exemption also needs his own words to carry no payment app, messaging app, contact ask or meetup word (a code check, not a row). A value at or below `floor.safety.location_offplatform` (`0.5`) restores the previous behaviour, since a read below that floor never fires; between the two, a value only narrows the exemption. Platform rows only: a creator row is ignored | `packages/engine/src/config/load.ts`, `packages/engine/src/routing/route.ts` |
| `pitch.min_gap_rounds` | `5` | rounds between AI-started pitches (a buy ask skips it) | `packages/engine/src/config/load.ts` |
| `pitch.fit_floor` | `0.58` | Jev's "this is a natural moment to pitch" probability needed for an AI-started pitch | `packages/engine/src/config/load.ts` |
| `pitch.max_declines` | `2` | declines within the window that stop pitching | `packages/engine/src/config/load.ts` |
| `pitch.decline_window_minutes` | `20` | the window those declines are counted in | `packages/engine/src/config/load.ts` |
| `pitch.hardship_cooldown_hours` | `72` | no pitching at all after a hardship reading, even on a buy ask | `packages/engine/src/config/load.ts` |
| `pitch.velocity_max_unlocks` | `3` | this many unlocks in the window stop pitching | `packages/engine/src/config/load.ts` |
| `pitch.velocity_window_minutes` | `30` | the window those unlocks are counted in | `packages/engine/src/config/load.ts` |
| `ts.max_strikes` | `3` | boundary strikes (a meetup or off-platform ask) that pause the chat for Trust & Safety review; the fan sees "Warning n of this" | `packages/engine/src/config/load.ts`, `packages/engine/src/routing/route.ts` |
| `ts.strike_window_days` | `90` | strikes older than this many days do not count | `packages/engine/src/config/load.ts`, `packages/engine/src/turn/facts.ts` |

### Retrieval

| key | default | what it does | read in |
|---|---|---|---|
| `retrieval.voyage_model` | `"voyage-4"` | embedding model for persona chunks and sim lines | `examples/app/lib/host/deps.ts` |
| `retrieval.k` | `5` | persona chunks retrieved per turn | `packages/engine/src/config/load.ts` |
| `retrieval.strategy` | `"vector"` | `fts`, `vector` or `hybrid`; seeded `vector`, the retrieval eval's winner. Test helpers pin `fts` so tests never call Voyage | `examples/app/lib/host/deps.ts` |

### Fan simulator

| key | default | what it does | read in |
|---|---|---|---|
| `sim.enabled` | `false` | kill switch; off refuses spawns and stops live runs at the next beat | `examples/app/lib/sim/run.ts`, `examples/app/lib/sim/spawn.ts` |
| `sim.welcome_credit` | `true` | a spawned sim fan gets the welcome credit | `examples/app/lib/sim/spawn.ts` |
| `sim.model` | `"claude-haiku-5-5"` | the sim fan's voice | `examples/app/lib/sim/agent.ts` |
| `sim.max_tokens` | `120` | cap on one sim fan message | `examples/app/lib/sim/agent.ts` |
| `sim.max_concurrent_runs` | `5` | live runs at once; the rest queue | `examples/app/lib/sim/run.ts` |
| `sim.max_cost_micros_per_run` | `1000000` | a run at or over this stops (`cost_cap`) | `examples/app/lib/sim/run.ts` |
| `sim.max_cost_micros_per_batch` | `10000000` | a batch at or over this stops its runs | `examples/app/lib/sim/run.ts` |
| `sim.lease_ms` | `120000` | how long one caller holds a run | `examples/app/lib/sim/drive.ts` |
| `sim.tick_budget_ms` | `45000` | how long one cron tick advances runs | `examples/app/app/api/cron/sim/route.ts` |
| `sim.burst_gap_ms` | `100` | gap between the lines of a burst beat | `examples/app/lib/sim/beats.ts` |
| `sim.demo_gap_ms` | `8000` | pause before each fan message in demo mode | `examples/app/lib/sim/beats.ts` |
| `sim.human_wait_ms` | `600000` | how long demo mode waits for a person at a human step | `examples/app/lib/sim/beats.ts` |
| `sim.webhook_wait_ms` | `20000` | how long a sim top-up waits for the Stripe webhook | `examples/app/lib/sim/stripe.ts` |
| `sim.topup_payment_method` | `"pm_card_visa"` | the Stripe test payment method sim top-ups use | `examples/app/lib/sim/stripe.ts` |

How many messages a sim fan sends is not a config row: it is the number of message beats in its persona file
(`data/sim/personas/<slug>.json`, documented in `docs/quality/FAN-SIM.md` section 3).

## Code constants

| constant | value | what it does | file |
|---|---|---|---|
| `TYPING_AFTER_SEND_MS` | `500` | Juno's typing row waits this long after the fan sends | `examples/app/lib/ui/typing-delay.ts` |
| `RECENT_BUBBLES` | `8` | her last bubbles whose emoji the next reply avoids | `packages/engine/src/drafting/emoji.ts` |
| `TYPING_WINDOW_SECONDS` | `3` | how long a fan typing ping counts as "still typing" | `examples/app/lib/chat/typing-window.ts` |
| `TYPING_PING_INTERVAL_MS` | `2000` | how often the fan's client sends a typing ping | `examples/app/lib/chat/typing-window.ts` |
| `CHANGES_OVERLAP_MS` | `5000` | how far before its cursor a thread change read looks again, for rows committed late | `examples/app/lib/conversations/paging.ts` |
| `AI_PENDING_WINDOW_MS` | `90_000` | how long an open turn counts as "she is replying" in the chat view | `examples/app/lib/conversations/read.ts` |
| `POLL_FALLBACK_MS` | `3000` | chat poll interval when realtime is down | `examples/app/components/chat/live-thread.tsx` |
| `POLL_WHILE_AI_MS` | `2500` | chat poll interval while a reply is due | `examples/app/components/chat/live-thread.tsx` |
| `READ_ONLY_POLL_MS` | `30_000` | poll interval for a read-only chat | `examples/app/components/chat/live-thread.tsx` |
| `DUE_SLACK_MS` | `500` | slack after a bubble's due time before the view re-checks | `examples/app/components/chat/live-thread.tsx` |
| `POLL_MS` | `5000` | refresh interval for pages that follow live events | `examples/app/components/chat/refresh-on-event.tsx` |
| `CLOSE_MS` | `160` | account menu close animation | `examples/app/components/ui/chat/account-menu.tsx` |
| `SIDEBAR_MIN` | `260` | narrowest the console sidebar can be dragged (px) | `examples/app/lib/ui/sidebar-width.ts` |
| `SIDEBAR_MAX` | `480` | widest the console sidebar can be dragged (px) | `examples/app/lib/ui/sidebar-width.ts` |
| `PAGE_SIZE` | `10` | rows per page in the analytics turn list (pages load in place, no navigation) | `examples/app/lib/analytics/turns.ts` |
| `SWEEP_START_BUDGET_MS` | `35_000` | the sweep starts no new conversation after this, inside its 60 s function | `packages/engine/src/conversation/sweep.ts` |
| `DRIVE_MS` | `50_000` | how long a Spawn on /admin/sim drives its runs before the tick takes over | `examples/app/app/admin/sim/actions.ts` |
| `TICK_MS` | `15_000` | how long each /admin/sim page tick advances a live run | `examples/app/app/admin/sim/actions.ts` |
| `EXPORT_ENTRY_MAX_BYTES` | `268_435_456` | the largest single file the Instagram export reader will inflate from a zip | `packages/persona/src/export/zip.mjs` |
| `MIN_MARKER_TEXTS` | `30` | replies her voice-marker rates need before any card stores them (`readMarkers`, so `persona:load`, `persona:publish` and `init` agree) | `examples/app/scripts/persona/load.ts` |
| `EVERY_MS` | `6_000` | gap between /admin/sim page ticks | `examples/app/app/admin/sim/live-ticker.tsx` |
