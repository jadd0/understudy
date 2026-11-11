# Understudy

An engine that answers a creator's fan messages in the creator's own voice, sells their content when the moment
fits, and hands the conversation to a human when it should. It learns the voice from the creator's own Instagram,
runs headless in any Node host, and ships with two hosts that prove it: a Fastify server and a full Next.js app.

**Code decides, models only write.** Routing, offers, prices, safety stops and hand-offs are code paths with tests.
The language models classify messages and draft words; every draft is checked by code and by a second model before
it is sent.

The demo creator, Juno Vale, is fictional: her posts and replies are generated, so no real person's data is in this
repository. [How it came to be](docs/CASE-STUDY.md) tells the story from a take-home brief to a library.

## Ten-minute start

You need Node 22 or newer, npm, and Docker (for a local Postgres) or a Neon database.

**A. No keys at all.** A scripted fan talks to Juno on scripted providers: you watch her replies arrive with typing
delays, an offer for one of her sets, a human takeover and a hand-back.

```bash
npm ci
docker compose up -d --wait
DATABASE_URL=postgres://postgres:postgres@localhost:5437/understudy npm run server:demo -- --fake
```

`docker compose up` starts Postgres 18 with `pgvector` and Neon's WebSocket proxy in front of it, so the Neon driver
the code uses works unchanged ([docker-compose.yml](docker-compose.yml)). A `DATABASE_URL` on `localhost` goes through
that proxy; any other host is taken to be a Neon database.

**B. One key.** The same conversation with real replies from Claude. Retrieval uses Postgres full-text search, so
Claude is the only key.

```bash
CLAUDE_SECRET_KEY=<key> DATABASE_URL=postgres://postgres:postgres@localhost:5437/understudy npm run server:demo
```

**C. The app.** The Next.js app (fan chat, creator console, admin, wallet) runs on a Neon database; its pooled
connection is not pointed at the local proxy. Create a free Neon project, then:

```bash
cp examples/app/.env.example examples/app/.env.local   # fill DATABASE_URL, AUTH_SECRET and CLAUDE_SECRET_KEY at minimum
npm run check:env                                      # names missing or malformed keys, never prints a value
npm run db:migrate && npm run db:seed
npm run persona:load -- --creator junovale
npm run persona:publish -- --creator junovale --card-version 2
npm run dev                                            # http://localhost:3000
```

Open `/signin` with any email address; with no mail key set, the sign-in link is printed in the server console. After
the date-of-birth step, `/chat?c=junovale` is the conversation with Juno. Only a creator with a published card can be
reached, which is why the two `persona` commands are not optional. [APP.md](docs/app/APP.md#running-it-locally) has
the rest, including the creator console and admin seats.

Everything beyond `DATABASE_URL`, `AUTH_SECRET` and `CLAUDE_SECRET_KEY` is optional and degrades as follows;
`npm run check:env` prints which are on.

| service | key(s) | without it |
|---|---|---|
| Jev (TypeSafe) | `TYPESAFE_SECRET_KEY` | Claude makes the reply decisions alone |
| Voyage | `VOYAGE_API_KEY` | retrieval uses full-text search whatever retrieval.strategy says |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | demo wallet on the welcome credit, top-ups are off |
| Pusher | `PUSHER_*`, `NEXT_PUBLIC_PUSHER_*` | no realtime events, the browser polls |
| Resend | `RESEND_API_KEY`, `EMAIL_FROM` | the sign-in link is printed to the server console (refused in production) |
| Turnstile | `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | no human check outside production (refused in production) |

Production (`NODE_ENV=production`) never skips the sign-in email or Turnstile: with either missing, sign-in is
refused. `npm run check:env -- <file> --production` lists every key a deploy needs.

## Run it in a container

The headless server runs in a container against a Neon database. A `localhost` `DATABASE_URL` inside the container is
the container itself, so the compose Postgres is for running from source, not for the image:

```bash
docker build -t understudy-server .
docker run -e DATABASE_URL=<neon url> -e UNDERSTUDY_API_KEY=<a long random key> -e CLAUDE_SECRET_KEY=<your Anthropic key> -p 8787:8787 understudy-server
```

[examples/server](examples/server/README.md) documents the HTTP API: `POST /v1/messages`, a server-sent event stream
of reply bubbles, takeover, hand-back and a signed webhook.

## Onboard a creator

One command takes a creator from her own Instagram to a published persona, in two phases with a pause between them so
she can read and edit the card.

```bash
npx understudy init --instagram-export <zip or folder> --email <her address> --card-model <claude model id>
npx understudy init --scrape-own --email <her address> --card-model <claude model id>
npx understudy init --publish <the directory phase one printed>
```

It reads her own account only: Instagram's own data download, or a scrape of the account her own session belongs to,
which refuses any other handle. Direct messages are never read. Phase one builds the persona bank and drafts the card;
phase two publishes it and creates the creator. [PERSONA-PIPELINE.md](docs/persona/PERSONA-PIPELINE.md#onboarding-a-creator-npx-understudy-init)
has the flags, what an export is read for and what it lacks.

## Use the engine in your own host

A host hands the engine its database, its settings, its own tables (wallet, catalogue, users) through one interface,
and the model providers. The packages are not on npm yet; in this repository they are workspaces that import nothing
from either host, and a test fails the build if one does.

```ts
import { createUnderstudy } from "@jadd0/understudy-engine";

const understudy = createUnderstudy({ db, config, host, deps });
await understudy.migrate();

const { process } = await understudy.handleMessage({ creatorId, fanId, body, clientMsgId });
await process(); // answer now, or later from a queue
```

`packages/engine` and `packages/providers` build to ES modules with declarations (`npm run build:packages`, plain `tsc`);
`packages/persona` is plain ES modules. All three are set up to publish as `@jadd0/understudy-engine`,
`@jadd0/understudy-providers` and `@jadd0/understudy-persona`. `npm run pack:smoke` installs their packed tarballs into a
scratch project and runs the headless quick start; `npm run release:dry-run` rehearses the publish and never publishes.

[packages/engine/README.md](packages/engine/README.md) lists the ports, the tables the engine owns and the
migrations it applies itself; [examples/server](examples/server/README.md) is a complete host in a few hundred lines.

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
- **Switchable safety checks.** The five hard-stop checks (minor, self-harm, threat, meetup or off-platform, payment dispute)
  are on by default. A platform can switch one off with `safety.<check>.enabled`; a creator never can, and the engine
  logs a warning naming each one that is off. Doing so is the operator's responsibility ([safety](docs/safety/SAFETY.md)).
- **Many creators, isolated.** Every row carries its creator; isolation tests prove no chunk, card, config row,
  catalogue item or memory crosses between two creators ([scaling](docs/operations/SCALING.md)).

## Measured

Every number here comes from a committed run; the docs give the method and the raw output.

| what | result | source |
|---|---|---|
| Engine eval: 64 scripted threads, 99 turns across the routing matrix | **0 safety violations**, 0 errored turns, $0.0002 per replying turn | [EVALS](docs/quality/EVALS.md) |
| Retrieval: recall@5 on labelled queries | vector 0.560, full text 0.331, hybrid 0.482 | [EVALS](docs/quality/EVALS.md) |
| Blind test: a judge model tries to pick her real reply over the bot's, 100 judgements | 58.0% (95% CI 48.2–67.2%; 50% means indistinguishable): the interval includes chance. The judge also leans to answer A (36% with the bot in A, 80% in B) | [EVALS](docs/quality/EVALS.md) |
| Hot paths at 200 creators, 20,000 conversations, 1,000,000 messages (Neon, Postgres 18.6) | lease claim 0.09 ms, facts 0.17 ms, vector retrieval 0.29 ms (p50) | [SCALING](docs/operations/SCALING.md) |
| Background sweep at the same volume | 21.8 ms → 5.07 ms p50 after one measured index | [SCALING](docs/operations/SCALING.md) |

## Layout

```
packages/
  engine/      the conversation engine: createUnderstudy(), its ports, its own schema and migrations
  providers/   adapters for the ports: Claude, Jev (TypeSafe), failover with circuit breakers, Postgres and Voyage retrieval
  persona/     the persona pipeline and CLI: scrape, build, synth, draft the card, evaluate, leak-check
examples/
  server/      a headless Fastify host: HTTP in, server-sent replies, takeover, a signed webhook
  app/         a Next.js host: fan chat, creator console, admin, wallet, Stripe, realtime
data/          the synthetic creator's persona bank, eval threads and simulated fans
docs/          everything else; start at docs/README.md
```

## Checks

```bash
docker compose up -d --wait
npm run check
```

`npm run check` runs typecheck, lint, the test suite against a throwaway local database, the build, the persona and
environment checks, the public-file and link checks, the Dockerfile checks, this README's own commands and the leak
check. It stops at the first failure and needs no private files. The leak check is the one step that reads two of
them, and skips what an unset one would check, saying so:

- `LEAK_CHECK_RAW` names a private directory holding a raw scrape of a real account. No sentence of it, and no handle
  in it, may appear in any tracked file.
- `LEAK_CHECK_NAMES` names a private text file of names (a company, a creator) that no tracked file or path may
  contain, one per line.

Both go in `examples/app/.env.local` (see `examples/app/.env.example`). `npm run persona:leak -- --require` is the
strict form: it exits 2 when either is unset or empty, or when the raw directory holds no text, so a check that cannot
run never passes on nothing. The leak check prints a file and line for a hit, never the text.
[DEVELOPMENT.md](docs/operations/DEVELOPMENT.md) has the rest.

## Docs

Start at [docs/README.md](docs/README.md). The short list:

- [CASE-STUDY.md](docs/CASE-STUDY.md): from a take-home brief to a library, and what is still open.
- [APP.md](docs/app/APP.md): the whole Next.js app in one document.
- [ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md) and [DATA-MODEL.md](docs/architecture/DATA-MODEL.md): the engine and its tables.
- [SAFETY.md](docs/safety/SAFETY.md): what the AI handles, what goes to a human, and what the code does not cover.
- [EVALS.md](docs/quality/EVALS.md) and [SCALING.md](docs/operations/SCALING.md): every measured number.

## Responsibility

Running it for real means the operator owns age assurance, payments and content rules for their market;
[SAFETY.md](docs/safety/SAFETY.md) says what the code does and does not cover. Collect only an account whose owner has
agreed to it: the scraper and `init` refuse any other.
