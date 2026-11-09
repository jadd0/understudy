# Understudy

An engine that answers a creator's fan messages in the creator's own voice, sells their content when the moment
fits, and hands the conversation to a human when it should. It learns the voice from the creator's Instagram,
runs headless in any Node host, and ships with two hosts that prove it: a Fastify server and a full Next.js app.

**Code decides, models only write.** Routing, offers, prices, safety stops and hand-offs are code paths with tests.
The language models classify messages and draft words; every draft is checked by code and by a second model before
it is sent.

The demo creator, Juno Vale, is fictional: her posts and replies are generated, so no real person's data is in this
repository.

## Try it without any API keys

```bash
npm ci
DATABASE_URL=postgres://… npm run server:demo -- --fake
```

The headless server starts on any Postgres database with `pgvector` (a free Neon project works), a scripted fan
talks to Juno, and you watch her replies arrive with typing delays, an offer for one of her sets, a human takeover
and a hand-back. `--fake` swaps the model providers for scripted ones, so no model key is needed.

## What it does

- **Persona from Instagram.** A pipeline turns a creator's posts and comment replies into a style card and a
  retrieval bank, holds out a test split, and scores the result ([persona](docs/persona/PERSONA-PIPELINE.md)). The
  scraper collects your own account only ([scraper](docs/persona/SCRAPER.md)).
- **One message turn.** Wait while the fan is still typing, classify the batch, route it (reply, offer, deflect,
  hold for the creator, safety stop), retrieve her past lines, draft, verify, split into timed bubbles, and commit
  under a lease and a compare-and-set so a human takeover always wins ([architecture](docs/architecture/ARCHITECTURE.md)).
- **Safety in code.** Minors, self-harm and threats stop the AI at once. A meetup or off-platform ask gets a
  boundary line in her voice and a numbered warning; the third pauses the chat for review ([safety](docs/safety/SAFETY.md)).
- **Escalation that waits on nobody.** A chat held for the creator gets a short holding line; if no one picks it up
  in time, a policy resolves it and the AI carries on. Trust and safety cases are never auto-resolved: a late one is
  flagged to an ops channel.
- **Money in integer cents.** A prepaid wallet with an append-only ledger, daily caps, unlocks and tips. Offers come
  only from the creator's catalogue, at catalogue prices, and never above the fan's cap
  ([monetisation](docs/app/MONETISATION.md)).
- **Built to survive its vendors.** Each external service sits behind one adapter with a tested fallback: a second
  model when the drafting model is down, Claude when the classifier is down, full-text search when embeddings are
  down, polling when realtime is down ([continuity](docs/operations/CONTINUITY.md)).
- **Many creators, isolated.** Every row carries its creator; isolation tests prove no chunk, card, config row,
  catalogue item or memory crosses between two creators ([scaling](docs/operations/SCALING.md)).

## Measured

Every number here comes from a committed run; the docs give the method and the raw output.

| what | result | source |
|---|---|---|
| Engine eval: 72 scripted turns across the routing matrix | **0 safety violations**, 0 errored turns, $0.0002 per replying turn | [EVALS](docs/quality/EVALS.md) |
| Retrieval: recall@5 on labelled queries | vector 0.560, full text 0.331, hybrid 0.482 | [EVALS](docs/quality/EVALS.md) |
| Blind test: a judge model tries to pick her real reply over the bot's, 50 pairs judged in both orders | 65.0% (95% CI 55.3–73.6%): still detectable, reported as is | [EVALS](docs/quality/EVALS.md) |
| Hot paths at 200 creators, 20,000 conversations, 1,000,000 messages (Neon, Postgres 18.6) | lease claim 0.09 ms, facts 0.17 ms, vector retrieval 0.29 ms (p50) | [SCALING](docs/operations/SCALING.md) |
| Background sweep at the same volume | 21.8 ms → 5.07 ms p50 after one measured index | [SCALING](docs/operations/SCALING.md) |

## Layout

```
packages/
  engine/      the conversation engine: createChatter(), its ports, its own schema and migrations
  providers/   adapters for the ports: Claude, Jev (TypeSafe), failover with circuit breakers, Postgres and Voyage retrieval
  persona/     the persona pipeline and CLI: scrape, build, synth, draft the card, evaluate, leak-check
examples/
  server/      a headless Fastify host: HTTP in, server-sent replies, takeover, a signed webhook
  app/         a Next.js host: fan chat, creator console, admin, wallet, Stripe, realtime
data/          the synthetic creator's persona bank, eval threads and simulated fans
docs/          everything else; start at docs/README.md
```

The packages import nothing from either host, and a test fails the build if one does. A host hands the engine its
database, its settings, its own tables (wallet, catalogue, users) through one interface, and the model providers:

```ts
import { createChatter } from "@understudy/engine";

const chatter = createChatter({ db, config, host, deps });
await chatter.migrate();

const { process } = await chatter.handleMessage({ creatorId, fanId, body, clientMsgId });
await process(); // answer now, or later from a queue
```

## Quick start

Needs Node, npm and a Postgres database with `pgvector`.

```bash
npm ci
cp examples/app/.env.example examples/app/.env.local   # DATABASE_URL, CLAUDE_SECRET_KEY, VOYAGE_API_KEY at minimum
npm run check:env              # names missing or malformed keys, never prints a value
npm run db:migrate && npm run db:seed && npm run persona:load -- --creator junovale
npm run dev                    # the app at http://localhost:3000
```

`bash scripts/gate.sh` runs typecheck, lint, the test suite against a throwaway database, the build and the
repository checks; it is the only proof a change works. [DEVELOPMENT.md](docs/operations/DEVELOPMENT.md) has the rest, and
[examples/server](examples/server/README.md) documents the headless API.

## The app in five minutes

Use three browser profiles so the sessions stay apart.

1. **Fan.** `/signin`, enter an email, open the link, confirm a date of birth and the 18+ tick. `/chat` with Juno; a
   welcome credit is in the wallet. Ask for something she sells to see an offer, and unlock it.
2. **Creator.** `/signin` with `SEED_CREATOR_EMAIL` and `DEMO_SEAT_PASSWORD`. `/console` shows the conversation
   live. Take it over, write as her, hand it back.
3. **Admin.** `/signin` with an address from `SEED_ADMIN_EMAILS`. `/admin` lists every conversation and its flags;
   `/analytics` shows the numbers.

## Status

The engine, both hosts and everything above are built and tested. In progress:

- **Minimal mode:** Postgres and one model key, every other service optional.
- **One-command onboarding:** `npx understudy init` from your own Instagram data export.
- **Any creator in the app:** no demo creator in the code, plus a catalogue editor.
- **Toggleable safety checks** per platform, on by default.
- **A gateway adapter** for a self-hosted, OpenAI-compatible LLM gateway with per-creator budgets.
- **npm packages** for the engine, providers and persona pipeline.

Running it for real means the operator owns age assurance, payments and content rules for their market;
[SAFETY.md](docs/safety/SAFETY.md) says what the code does and does not cover.
