# Development

Next.js 16 App Router, TypeScript strict, Tailwind 4, Drizzle on Neon, Auth.js v5, vitest. npm only.
The build contract is `AGENTS.md`.

## Setup

1. `npm install`
2. Copy the keys listed in `.env.example` into `.env.local` (names only here; see
   [AUTH.md](AUTH.md#environment-keys) for what each is for). `.env*.local` is gitignored.
3. `npm run check:env` checks the file. `npm run db:migrate` applies `drizzle/` to `DATABASE_URL` (Neon `neondb`).
4. `npm run db:seed` creates the creator (from `SEED_CREATOR_EMAIL`) and admins (`SEED_ADMIN_EMAILS`),
   idempotently; each is skipped with a message if its variable is unset.
5. `npm run dev`.

## Commands

| command | does |
|---|---|
| `npm run dev`, `build`, `start` | Next.js |
| `npm run typecheck`, `lint`, `test` | `tsc --noEmit`, ESLint, vitest (against the per-branch test database, [DATA-MODEL.md](DATA-MODEL.md#test-database-d-039)) |
| `npm run db:generate` | drizzle-kit writes a migration to `drizzle/` from `db/schema.ts` |
| `npm run db:migrate`, `db:seed` | apply migrations; seed creator and admins |
| `bash scripts/gate.sh` | the gate |
| `npx understudy-persona build --creator junovale --card-model <id> --gen-model <id> --jev-model <id>` | persona build; see [PERSONA-PIPELINE.md](PERSONA-PIPELINE.md#running-it) |
| `node --test 'packages/persona/src/**/*.test.mjs' scripts/persona/*.test.mjs` | persona tests only |

## The gate

`bash scripts/gate.sh` is the only proof that a change works: it must print `gate: PASS`. It reads
`.product/gate-steps` (name, tab, command), runs the steps in order, skips the rest after the first
failure, and writes each step's output to `gate-logs/<step>.log`. A gate with no steps fails. One gate
runs at a time across all worktrees (a lock). A pass writes a stamp (`scripts/gate-stamp.mjs`) that fingerprints the tree and
the files in `gate_inputs` (`.env.local`, `node_modules/.package-lock.json`).

| step | command |
|---|---|
| typecheck | `npm run --silent typecheck` |
| lint | `npm run --silent lint` |
| test | `npm run --silent test` |
| build | `npm run --silent build` |
| persona | `node --test 'packages/persona/src/**/*.test.mjs' scripts/persona/*.test.mjs` (includes the split-hygiene tests over committed data) |

Add a check as a new line in `.product/gate-steps`, never by editing `gate.sh`.

## Worktrees

Each PR is built on its own branch in a worktree under `.claude/worktrees/<branch>` (gitignored):
`bash scripts/worktree-setup.sh <branch> [<path>] [<base>]`. It links `node_modules` (hard-linked; run
`npm install` in at most one tree), copies `.env.local`, and writes a code map. The merge policy is
`merge-when-green` to local main and never push (`.product/config.md`, ). The loop is light: the
founder and Claude build directly, with no unattended coordinator. Tests use a database per
branch.

## Decision log

`.product/DECISIONS.md` records every decision with an id, who made it, why, and where the code is.
**Read it before changing behaviour that looks wrong**; a reversal adds a new entry and marks the old
one superseded rather than rewriting it. Also useful: `.product/plans/pr-*.md` (what each PR was
meant to do), `.product/roadmap.md` (status), `.product/FOUNDER-TODO.md` (what waits on the founder).

Note: `.product/config.md` still says `db: none` for the worktree-database feature of the kit; the
project's actual database setup is  and .
