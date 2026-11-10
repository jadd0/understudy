# Development

Next.js 16 App Router, TypeScript strict, Tailwind 4, Drizzle on Neon, Auth.js v5, vitest. npm only.
The build contract is `AGENTS.md`.

## Setup

1. `npm install` (an npm workspace: `packages/*` is the library, `examples/server` and `examples/app` are two hosts on it)
2. Copy the keys listed in `examples/app/.env.example` into `examples/app/.env.local` (names only here; see
   [AUTH.md](../app/AUTH.md#environment-keys) for what each is for). `.env*.local` is gitignored.
3. `npm run check:env` checks the file. `npm run db:migrate` applies the engine's migrations and then `examples/app/drizzle/` to `DATABASE_URL` (Neon `neondb`).
4. `npm run db:seed` creates the creator (from `SEED_CREATOR_EMAIL`) and admins (`SEED_ADMIN_EMAILS`),
   idempotently; each is skipped with a message if its variable is unset.
5. `npm run dev`. Run the Next scripts from the repository root: the app reads `data/` and `docs/quality/evals/` relative to the working directory, and the root scripts start Next with the repository root as that directory.

## Minimal setup

Only `DATABASE_URL`, `AUTH_SECRET` and `CLAUDE_SECRET_KEY` are required for the app. Every other provider is optional
and has a fallback:

| service | key(s) | without it |
|---|---|---|
| Jev (TypeSafe) | `TYPESAFE_SECRET_KEY` | Claude makes the reply decisions alone |
| Voyage | `VOYAGE_API_KEY` | retrieval uses full-text search whatever retrieval.strategy says |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | demo wallet on the welcome credit, top-ups are off |
| Pusher | `PUSHER_*`, `NEXT_PUBLIC_PUSHER_*` | no realtime events, the browser polls |
| Resend | `RESEND_API_KEY`, `EMAIL_FROM` | the sign-in link is printed to the server console (refused in production) |
| Turnstile | `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | no human check outside production (refused in production) |

With no Resend key, `/signin` still works: Auth.js issues its normal one-time link and the server console prints
`sign-in link for <address>: <url>`. Open that link in the same browser. `npm run check:env` prints the table above for
your `.env.local`. The headless server is `npm run server:dev` (`examples/server/.env.example` lists its variables).

## Commands

| command | does |
|---|---|
| `npm run dev`, `build`, `start` | Next.js, the app in `examples/app/` |
| `npm run typecheck`, `lint`, `test` | `tsc --noEmit`, ESLint, vitest (against the per-branch test database, [DATA-MODEL.md](../architecture/DATA-MODEL.md#test-database)) |
| `npm run db:generate` | drizzle-kit writes a migration to `packages/engine/drizzle/` from the engine schema, then one to `examples/app/drizzle/` from `examples/app/db/host-schema.ts` |
| `npm run db:migrate`, `db:seed` | apply migrations; seed creator and admins |
| `bash scripts/gate.sh` | the gate |
| `npx understudy-persona build --creator junovale --card-model <id> --gen-model <id> --jev-model <id>` | persona build; see [PERSONA-PIPELINE.md](../persona/PERSONA-PIPELINE.md#running-it) |
| `npx understudy init (--instagram-export <zip\|folder> \| --scrape-own) --email <address> --card-model <id>`, then `npx understudy init --publish <dir>` | onboard a creator from her own Instagram; see [PERSONA-PIPELINE.md](../persona/PERSONA-PIPELINE.md#onboarding-a-creator-npx-understudy-init) |
| `node --test 'packages/persona/src/**/*.test.mjs' scripts/persona/*.test.mjs` | persona tests only |

## The gate

`bash scripts/gate.sh` is the only proof that a change works: it must print `gate: PASS`. It reads
the gate's step list, `gate-steps` (name, tab, command), runs the steps in order, skips the rest after the first
failure, and writes each step's output to `gate-logs/<step>.log`. A gate with no steps fails. One gate
runs at a time across all worktrees (a lock). A pass writes a stamp (`scripts/gate-stamp.mjs`) that fingerprints the tree and
the files in `gate_inputs` (`examples/app/.env.local`, `node_modules/.package-lock.json`).

| step | command |
|---|---|
| typecheck | `npm run --silent typecheck` |
| lint | `npm run --silent lint` |
| test | `npm run --silent test` |
| build | `npm run --silent build` |
| persona | `node --test 'packages/persona/src/**/*.test.mjs' scripts/persona/*.test.mjs` (includes the split-hygiene tests over committed data) |

Add a check as a new line in the gate-steps file, never by editing `gate.sh`.

## Worktrees

Each PR is built on its own branch in a worktree under `.claude/worktrees/<branch>` (gitignored):
`bash scripts/worktree-setup.sh <branch> [<path>] [<base>]`. It links `node_modules` (hard-linked; run
`npm install` in at most one tree), copies `examples/app/.env.local`, and writes a code map. The merge policy is
`merge-when-green` to local main and never push. The loop is light: the
founder and Claude build directly, with no unattended coordinator. Tests use a database per
branch.

## Decision log

Decisions are kept in a log with an id, who made it, why, and where the code is. It is part of the
build tooling and is not published with the repo. A reversal adds a new entry and marks the old one
superseded rather than rewriting it.

Dev and demo use the hosted Postgres in `DATABASE_URL`; tests and the gate use a local one, a database per branch
(`docker compose up -d` first; [DATA-MODEL.md](../architecture/DATA-MODEL.md#test-database)).
