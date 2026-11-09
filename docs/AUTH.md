# Authentication and access

Auth.js v5 (`next-auth@beta`) with the Resend provider and the Drizzle adapter; sessions live in the
database (`session.strategy = "database"`). Nothing is hand-rolled (, AGENTS.md). Files:
`lib/auth/index.ts`, `lib/auth/turnstile.ts`, `lib/auth/guards.ts`, `lib/auth/onboarding.ts`, `lib/auth/demo-seats.ts`,
`app/signin/**`, `app/onboarding/**`, `app/api/auth/[...nextauth]/route.ts`.

## Fan sign-in

1. `/signin` renders an email field, a password field (for team accounts) and the Turnstile widget.
2. The `requestSignIn` server action runs, in this order:
   1. Verify the Turnstile token with Cloudflare (`lib/auth/turnstile.ts`). Nothing is sent or stored for a
      visitor who has not passed. A missing token, a non-OK response, `success` not `true`, or a network
      error is a failure (fail closed) and redirects to `/signin?error=turnstile`.
   2. Validate the email (zod, trimmed, lower-cased); else `?error=email`.
   3. Call `signIn("resend", { email })`; Auth.js emails a one-tap link.
3. The link goes to Auth.js's callback, which verifies the one-time token and creates a `sessions` row.

**Why `POST /api/auth/signin/*` is blocked.** Auth.js exposes its own provider endpoint. A direct POST to
it would send mail without the Turnstile check, so the route handler returns 403 for any POST whose path
starts with `/api/auth/signin`. GET (callback links, session) and other POSTs (such as sign-out) still go
to Auth.js. The only way to start an email sign-in is the checked server action.

## 18+ gate and flagging

A fan with no `adult_confirmed_at` is sent to `/onboarding`, which takes a date of birth and an "I am 18
or older" tick. `applyOnboarding` (`lib/auth/onboarding.ts`):

- Parses the date strictly (`YYYY-MM-DD`, a real day, not in the future, not before 1900), computes the
  age in UTC, with `now` injected.
- Invalid date: error, nothing written. Adult but box unticked: error, nothing written.
- Adult and ticked: writes `dob` and `adult_confirmed_at`.
- Under 18, ticked or not: sets `dob`, `flagged_at`, `flag_reason = 'under_18_declared'`, deletes the
  user's sessions, ends at `/blocked`.
- The update only matches a fan with no `dob` and no `flagged_at`, so both fields are written once and a
  replay (for example an adult date after an under-18 submit) changes nothing.

A sign of a minor in chat is also a hard stop that flags the account whatever was declared. The engine
sets `flag_reason = 'minor_in_chat'` and keeps the fan's sessions, unlike the under-18 date above: the fan is
told by a platform message in the chat, may still read it, and every send is refused (`SendRefused('restricted')`). Real ID checks (for example Stripe Identity) are documented as
production, not built.

## Roles and route guards

Roles: `fan`, `creator`, `admin` (`users.role`, default `fan`). `lib/auth/guards.ts` decides every protected
route on the server from the user row read fresh, so a flag set after a session was issued still blocks.

| situation | result |
|---|---|
| signed out | redirect `/signin` |
| `flagged_at` set | redirect `/blocked`, except a fan flagged `minor_in_chat`, who may read `/chat` (route `chatRead`) and is sent there from `/` |
| fan without `adult_confirmed_at` | redirect `/onboarding` |
| `/chat` | fans only |
| `/console` | creators and admins. An admin's inbox lists every conversation, T&S first (its read scope is all, ); settings apply to the platform creator; it acts as itself |
| `/admin` | admins only |
| any other role on a role route | 404, not a redirect, so the route's existence is not hinted |
| `/onboarding` for a non-fan | 404; for a confirmed fan, redirect `/chat` |

`/` sends a user to their home: `/chat`, `/console` or `/admin`. Server components and actions call
`requireRole`, `requireConsole` (creator or admin, role read from the row), `requireAdultFan`, `requireChatReader` (a fan,
including one restricted to reading), `requireOnboarding` or `redirectHome`. `/analytics` uses `requireAnalyticsViewer`
(`lib/analytics/viewer.ts`).

## Demo seats

We do not own `understudy.example`, so email cannot reach `juno@understudy.example` or `admin@understudy.example`, and
admin must not be open to anyone with the URL. Seats are the addresses in `SEED_CREATOR_EMAIL` and
`SEED_ADMIN_EMAILS` (`lib/auth/demo-seats.ts`).

- **Password.** For a seat, the action checks `DEMO_SEAT_PASSWORD` after Turnstile. The comparison is
  constant time over sha256 digests, so neither length nor content leaks; with no password configured it
  is always false. Wrong password: `/signin?error=seat`. Fans leave the password field blank.
- **The seat's account must already exist (`lib/auth/seat-account.ts`).** After the password, the action
  checks that the seed has created the seat's user row with the seat's role (`creator` for
  `SEED_CREATOR_EMAIL`, `admin` for `SEED_ADMIN_EMAILS`) and that it isn't flagged. Otherwise:
  `/signin?error=seat`, and Auth.js is never called. Without this, a seat signing in before the seed ran
  would make the Auth.js adapter create a default `fan` row that then owns the seat email.
- **Guessing the password.** There is no attempt counter: every attempt costs a Turnstile solve, and the
  password is four word-and-number parts generated for this demo. A per-IP or per-email lockout needs a
  table and is residual R4. The `?error=seat` message does reveal that an address is a seat, which is
  harmless because the seat addresses are handed to reviewers anyway.
- **Link capture.** The action calls `signIn("resend", { redirect: false })` inside `captureSeatLink`, an
  `AsyncLocalStorage` scope. The provider's `sendVerificationRequest` is wrapped by `seatAwareSender`:
  for a seat address inside a capture it keeps the link and sends nothing; anyone else gets the normal
  email. The browser is then sent to `/signin/continue?to=<callback path>` (`lib/auth/seat-handoff.ts`), which accepts only
  a same-origin `/api/auth/callback/resend?` path and navigates the whole window to it. A server-action redirect straight
  to the link did not work: Next followed it on the server and the session cookie never reached the browser.
- **A seat link outside a capture throws.** If any other path asks Auth.js for a seat link, the sender
  errors, so a seat link is never emailed and never issued without the password check.
- **Why Auth.js still creates the session.** We add a check in front of the library's flow and never
  issue a session ourselves: Auth.js verifies the one-time token and writes the `sessions` row. This keeps
  to the rule that auth is never hand-rolled.
- **Simultaneous sign-in.** Each sign-in makes its own verification token and its own `sessions` row,
  and Auth.js never revokes a user's other sessions, so two reviewers can be in the same seat at
  once. `db/seed.ts` creates the creator (handle `junovale`, display name `Juno`) and the admins
  idempotently.

## Environment keys

Validated by `lib/env/index.ts` (zod) on first use. Names only; values are in `.env.local`.

| key | needed now | purpose |
|---|---|---|
| `DATABASE_URL` | yes | Neon Postgres |
| `AUTH_SECRET` | yes | Auth.js |
| `AUTH_URL` | optional | Auth.js base URL |
| `RESEND_API_KEY`, `EMAIL_FROM` | yes | sign-in emails |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | yes | Turnstile widget and verification |
| `SEED_CREATOR_EMAIL`, `SEED_ADMIN_EMAILS` | optional | demo seats and seed (admins comma-separated) |
| `DEMO_SEAT_PASSWORD` | optional | shared seat password; without it seats cannot sign in |
| `CLAUDE_SECRET_KEY`, `TYPESAFE_SECRET_KEY` | optional to boot | the engine and persona scripts (Claude, Jev) |
| `VOYAGE_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PUSHER_*`, `NEXT_PUBLIC_PUSHER_*` | optional to boot | retrieval embeddings, wallet top-ups, realtime; all live. `scripts/check-env.mjs` requires them (and `CRON_SECRET`) in production |

## Sim fan links (fan simulator)

Sim fans (`users.is_sim`, `sim+<slug>-<run8>@sim.understudy.test`) have no mailbox. An admin on `/admin/sim` can press **Open as fan**:
`openAsFanAction` checks the run's user is a sim fan (a `@sim.understudy.test` address, `is_sim`, role fan), then calls
`signIn("resend", { redirect: false })` inside `captureSignInLink(email, fn)` (`lib/auth/demo-seats.ts`), which keeps the
link Auth.js produced for that one address instead of emailing it. Auth.js still verifies the one-time token and creates the
session, so a second use of the link is rejected. `seatAwareSender` throws for a sim address outside a capture for that same
address, so a sim fan cannot be emailed or signed in by any other path (for example by hand through `/signin`).
