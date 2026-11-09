# Analytics

`/analytics` shows how conversations behave: what the engine decided, what it cost, what it earned and where it
handed over to a person. It is read-only: no query writes, and the page adds no schema, config or engine behaviour.
The numbers are defined, with formulas and what each one leaves out, in the generated [METRICS.md](METRICS.md).
Data flow: [diagrams/analytics.html](diagrams/analytics.html).

## Who sees what

| Viewer | Scope | Notes |
|---|---|---|
| Creator | Her own creator id | Conversations that are in the Trust & Safety queue, or ever were, are left out of every figure and of the turn explorer. |
| Admin (Trust & Safety) | Every creator | Includes T&S conversations; read-only. |
| Fan, signed out, flagged | None | Signed out goes to `/signin`, a flagged account to `/blocked`, any other role gets a 404. |

The scope is computed on the server from the session by `analyticsScope` (`examples/app/lib/analytics/scope.ts`), which reads the
role fresh from the user row. Every query takes that scope; no page passes its own list. A `?creator=` in the URL is
ignored. A turn outside the viewer's scope returns 404, the same as one that does not exist.

## The range

`?range=24h|7d|30d`, default `7d`. Charts bucket hourly for 24h and daily otherwise, in UTC. The window is half open,
`[now - range, now)`. An empty window shows zeros, and any rate whose denominator is zero shows a dash, never NaN.

## Tiles and sections

| Section | What it shows |
|---|---|
| Headline tiles | Fan messages, revenue, cost per reply, handoff rate, each with the section's detail below. |
| Volume | Fan messages per bucket, AI replies, human replies, active conversations. |
| Route mix | Turns by route (reply, offer, hold_creator, hard_stop, deflect, ai_disclosure, none) and by outcome (replied, handoff, hard_stop, suggested, superseded, error). |
| Handoffs | Opened by queue and reason, claim and resolve time p50 and p95, how many are open now. |
| Offers | Funnel: made, unlocked, declined, expired, still open; acceptance rate; offer rate. |
| Revenue | Unlocks and tips per bucket in cents, revenue per conversation (mean, median), top fans by the high-value score. |
| Latency | p50 and p95 for Jev in, generate, Jev out, total, computed in SQL. |
| Cost | Spend per bucket, cost per reply, tokens and an estimated price by stage and model. |
| Responsible monetisation | Hardship turns, pitched despite hardship (must be 0), cooldowns running, fans at their daily cap. |
| Quality evals | Safety violations, handoff precision and recall (mean of queues), route accuracy from `docs/evals/engine.json`; persona rubric mean and blind-test accuracy from `docs/evals/persona.json`. Each tile reads "not run" while its file is missing or unreadable. |
| Turn explorer | 10 turns a page (`PAGE_SIZE`), filter by route and outcome; Previous and Next load the page in place through a server action (`turnsPageAction`) without a navigation. Each row opens one turn. |
| Payments needing review (admins only) | Open `uncredited_payments` rows: Checkout events that credited no wallet. "Mark resolved" (`resolveUncreditedAction`) sets `resolved_at`; any refund is done by hand in Stripe. |

Simulated fans (`users.is_sim`) are included and tagged "(sim)". `?sim=exclude` or `?sim=only` filters them; there is no
control on the page, and the range pills and the explorer's filter form drop the parameter. Fans the eval runner creates (email `eval+...@understudy.test`) are left out of every figure, so eval traffic never skews the live numbers. Fans appear as the first eight characters of
their id; no email or name is shown.

## One turn

`/analytics/turns/<id>` shows the fan messages the turn answered, the reply or held draft, attempts and persona
version, timings per stage, cost, the offer and handoff it produced, Jev's answers before and after the draft, and
the models and tokens used.

## The report

`npm run metrics:report` writes [METRICS.md](METRICS.md) from the database: every KPI over the last 30 days for all
creators, from the same functions the page calls (`getDashboard`). It is generated; edit `examples/app/lib/analytics/kpis.ts` or
the query and regenerate. The report reads whatever database `DATABASE_URL` names, so migrate it first.

## Charts

Hand-drawn SVG in `examples/app/components/charts/` on the kit's tokens (`accent`, `ink`, `surface`, `line`), one hue, no library.
Each chart has a title, a hover title on every mark, and a screen-reader table; the visible tables repeat every
number a bar shows.

## Failure modes

- A config row missing (`fan.high_value_half_life_days`, `floor.safety.hardship`, `wallet.daily_cap_cents`) makes
  the revenue or responsible query fail closed, as `getConfig` does elsewhere.
- Turn rows do not store which pacing rule blocked a pitch, so the responsible section reports hardship from the
  turn and cooldown and cap from current state; gap, decline and velocity blocks are not split out.
- Cost by model re-prices stored tokens at today's `price.*` rows, so it is an estimate; the totals are the stored
  `cost_micros`.
