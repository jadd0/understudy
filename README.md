# Understudy

A take-home build of an AI chatter for the creator Juno Vale, a fictional creator whose posts and replies are
generated: fans chat with a persona drawn from her Instagram-style voice, spend from a prepaid wallet on unlocks and tips, and humans (Juno, trust and safety)
can take over any conversation. Code decides routing, offers and prices; the models only draft and check.

## Layout

```
packages/   the library: engine, providers, persona (the conversation engine, its model and payment adapters, the persona pipeline)
examples/
  server/   a headless Fastify host on the packages: HTTP in, server-sent replies, human takeover, a signed webhook
  examples/app/app/      a Next.js host on the packages: fan chat, creator console, admin, wallet, Stripe, Pusher
data/       the synthetic creator's persona bank, eval threads and simulator personas
docs/       the documentation index is docs/README.md
```

The packages' runtime code imports nothing from either host; each host depends on them through `@understudy/engine`,
`@understudy/providers` and `@understudy/persona` (an npm workspace).

## Quick start

```bash
npm ci
cp examples/app/.env.example examples/app/.env.local    # DATABASE_URL, CLAUDE_SECRET_KEY, VOYAGE_API_KEY at minimum; see docs/DEVELOPMENT.md
npm run check:env              # names missing or malformed keys, never prints a value
npm run db:migrate && npm run db:seed && npm run persona:load -- --creator junovale
npm run dev                    # the app at http://localhost:3000, demo seats on /signin
npm run server:demo -- --fake  # the headless host, no keys
```

`bash scripts/gate.sh` (typecheck, lint, tests, build) is the only proof a change works. The build
contract is `AGENTS.md`.

## Five-minute demo

Use three browser profiles (or one normal window plus two private windows) so the sessions stay apart.

1. **Fan.** Profile A: `/signin`, solve the Turnstile widget, enter any email, open the emailed link,
   confirm a date of birth and the 18+ tick. Open `/chat` and message Juno; the $50 welcome credit is in
   the wallet. Try asking for something she sells to see an offer, and unlock it.
2. **Juno.** Profile B: `/signin` with `SEED_CREATOR_EMAIL` and `DEMO_SEAT_PASSWORD` (no email is sent for a
   seat). `/console` shows the conversation live. Take it over, send a message as her (profile A sees it
   arrive), then hand it back.
3. **Admin.** Profile C: `/signin` with an address from `SEED_ADMIN_EMAILS` and the same password. `/admin`
   lists every conversation and its flags; `/analytics` shows the KPIs.

## Headless server

The engine also runs without the Next app ([examples/app](examples/app/)): [examples/server](examples/server/README.md) is a Fastify host with an
HTTP API, server-sent replies, human takeover and a signed webhook. `npm run server:demo -- --fake` plays a scripted
conversation against Juno with no UI.

## Docs

All of it is in [docs/](docs/README.md), which has the full index. By topic:

| area | read |
|---|---|
| Deploy | [DEPLOY.md](docs/DEPLOY.md) |
| Setup, commands, gate | [DEVELOPMENT.md](docs/DEVELOPMENT.md) |
| The message engine | [ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Persona and retrieval | [PERSONA-PIPELINE.md](docs/PERSONA-PIPELINE.md), [RAG.md](docs/RAG.md) |
| Collecting your own Instagram (own account or written consent only) | [SCRAPER.md](docs/SCRAPER.md) |
| Auth, wallet, safety | [AUTH.md](docs/AUTH.md), [MONETISATION.md](docs/MONETISATION.md), [SAFETY.md](docs/SAFETY.md) |
| Platform risk and fallbacks | [CONTINUITY.md](docs/CONTINUITY.md) |
| Data | [DATA-MODEL.md](docs/DATA-MODEL.md), [SCALING.md](docs/SCALING.md) |
| Realtime and consoles | [REALTIME.md](docs/REALTIME.md), [CONSOLE.md](docs/CONSOLE.md) |
| Measurement | [EVALS.md](docs/EVALS.md), [METRICS.md](docs/METRICS.md), [ANALYTICS.md](docs/ANALYTICS.md) |
