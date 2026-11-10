# AGENTS.md — contributor guide

## Stack and commands

Next.js 16 App Router, TypeScript (strict), Tailwind 4, Drizzle ORM on `@neondatabase/serverless`
(WebSocket `Pool`, so transactions are interactive), Auth.js v5 (`next-auth@beta`) with the Resend
provider and the Drizzle adapter, Cloudflare Turnstile, vitest. npm only.

- `npm run dev | build | start` (the Next app in `examples/app/`; run from the repository root)
- `npm run typecheck | lint | test`
- `npm run db:generate` (drizzle-kit, writes `packages/engine/drizzle/` then `examples/app/drizzle/`), `npm run db:migrate` (engine migrations, then the host's), `npm run db:seed`
- `bash scripts/gate.sh` runs typecheck, lint, test, build, the persona and env checks, the codemap and the public-files check
- `npm run check` runs the same steps without the private steps file, and stops at the first failure

## Rules

- **Money is integer cents.** Never a float, never a decimal string. Column names end in `_cents`.
- **Every top-level creator-owned row carries `creator_id`**, even while only one creator exists. Rows that hang off a
  conversation (`messages`, `turns`, `offers`, `handoffs`) and `unlocks` reach their creator through a foreign key.
- **Lock order is conversation, then offer, then wallet, then user**. Any transaction that takes two of them
  takes them in that order; a write whose foreign key points at a conversation counts as taking it, so lock the
  conversation first.
- **No literals for model ids, prices or floors.** They live in `config` rows read through
  `getConfig(key, creatorId?)`, which throws `ConfigMissing` rather than fall back to a code default. Every row and every code timing constant is listed in `docs/operations/CONFIG.md`; `examples/app/db/config-doc.test.ts` fails the gate when one is missing or its default differs.
- **Providers** (Jev, Claude, Voyage, Stripe, Pusher) are reached through one adapter each, injected into the code
  that uses them, and faked in tests. The engine's adapters live in `packages/providers` (`@understudy/providers`);
  Stripe and Pusher, which serve the app's wallet and realtime, stay in `examples/app/providers/`.
- **Auth is Auth.js only.** Never hand-roll sessions, tokens or password handling.
- Comments say what the code does and why. They never cite a decision, finding or PR number.

## Auth flow

1. `/signin` renders the email form and the Turnstile widget.
2. The `requestSignIn` server action verifies the Turnstile token with Cloudflare first, then calls
   `signIn("resend", { email })`. A missing or failed token, or a network error, sends nothing.
   `POST /api/auth/signin/*` is refused at the route so the provider endpoint cannot bypass the check.
3. Auth.js emails a one-tap link. Sessions are stored in the database (`session.strategy = "database"`).
4. `examples/app/lib/auth/guards.ts` decides every protected route on the server, from the user row read fresh:
   signed out goes to `/signin`; a flagged account goes to `/blocked`, except a fan flagged `minor_in_chat`, who may
   read `/chat`; a fan without
   `adult_confirmed_at` goes to `/onboarding`; `/chat` is fans only, `/console` creators and admins,
   `/admin` admins only, and any other role gets a 404.
5. `/onboarding` takes a date of birth and an "I am 18 or older" tick. `examples/app/lib/auth/onboarding.ts` computes the
   age in UTC. An under-18 date sets `flagged_at`, deletes the user's sessions and ends at `/blocked`.
   `dob` and `adult_confirmed_at` are written once.

## Database in tests

Tests run on a local Postgres: `docker compose up -d` starts Postgres 18 with pgvector and Neon's WebSocket proxy
(`docker-compose.yml`), so the serverless driver works unchanged. `vitest.global-setup.ts` calls
`scripts/test-db.mjs`, which creates `<db>_test_<branch-slug>` there if absent (base: `TEST_DATABASE_BASE_URL`, default
the compose database; a non-local base is refused), applies the engine's migrations and then `examples/app/drizzle/`, and points `DATABASE_URL` at it. Tests never touch the dev database.
`TEST_DB_SCOPE=<x>` appends `_<x>` to that name: the gate runs 3 shards on `_s1`..`_s3` (`scripts/test-sharded.sh`),
so set your own scope (e.g. `TEST_DB_SCOPE=adhoc`) for a hand run while a gate may be running on the branch.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Tests live next to their source

A test sits in the same folder as the file it tests: `examples/app/lib/wallet/unlock.ts` → `examples/app/lib/wallet/unlock.db.test.ts`,
`examples/app/app/api/webhooks/stripe/route.ts` → `route.test.ts`. There is **no `test/` folder**; never create one.
Suffixes: `.test.ts` (pure), `.db.test.ts` (needs the per-branch test database), `.live.test.ts` (real
providers, opt-in with `LIVE=1`, excluded from the gate). Shared helpers sit beside what they build:
`examples/app/db/test-helpers.ts`, `examples/app/lib/wallet/test-helpers.ts`; fixtures beside their consumer
(`packages/persona/fixtures/`). Vitest's global setup is `vitest.global-setup.ts` at the root.

## `examples/app/lib/` is organised by domain

Every module lives in a domain folder; nothing sits loose in `examples/app/lib/`. A folder's public entry is its
`index.ts` when it has one (`@/lib/auth`, `@/lib/config`, `@/lib/env`), else import the file by name
(`@/lib/auth/guards`, `@/lib/wallet/unlock`). Tests sit beside each file.

| Folder | Holds |
|---|---|
| `examples/app/lib/auth/` | Auth.js setup (`index.ts`), route guards, onboarding/18+ (`age`, `onboarding`), Turnstile, demo seats |
| `examples/app/lib/config/` | `getConfig` over the `config` table (fail closed) and `dbConfigPort`, the engine's view of it |
| `examples/app/lib/env/` | validated environment |
| `examples/app/lib/wallet/` | ledger, top-up, unlock, tip, cap, high-value score, money parsing |
| `packages/engine/` | the engine as a workspace package (`@understudy/engine`): the message turn, its ports, retrieval over persona chunks, and the fakes behind `@understudy/engine/testing`. The app imports only the package entry |
| `packages/providers/` | the adapters behind the engine's ports as a workspace package (`@understudy/providers`): Claude, Jev, failover, Postgres full-text and Voyage retrieval, a no-op event sink. It imports nothing from the app; retrievers take their database as a constructor argument |
| `examples/server/` | the engine's second host (`@understudy/example-server`): a Fastify API with server-sent replies, takeover, hand-back and a signed webhook, no wallet and no UI. Same rules as any other consumer: it imports only the package entries |
| `examples/app/lib/host/` | the app's side of the engine's `HostPort` (`packages/engine/src/ports/host.ts`): the database-backed `dbHost` over wallet, ledger, catalogue, unlocks and users |
| `examples/app/lib/conversations/` | conversation reads and human actions: takeover, hand-back, release |
| `examples/app/lib/ui/` | pure view logic shared by components (message grouping) |
| `examples/app/lib/evals/` | engine eval: thread schema, runner, scorer, report rendering |
| `examples/app/lib/sim/` | the fan simulator: personas, the agent, guard, beats, run loop, spawn, reset, export |

A new domain gets a new folder and a row here.
