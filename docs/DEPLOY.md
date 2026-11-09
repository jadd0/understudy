# Deploy to Vercel

The founder runs this. It takes about 15 minutes once the accounts exist. Nothing here is run
by the build loop: no `vercel` command, no Stripe call. Every value comes from a dashboard, never from
a file in git.

## Before you start

- Accounts: Vercel, Neon, Resend, Cloudflare (Turnstile), Stripe (**test mode**), Pusher, plus the
  Anthropic, TypeSafe and Voyage keys you already use locally.
- A domain, or the `*.vercel.app` URL Vercel gives the project. Below it is written `<domain>`.
- Node 22 or newer locally, and `vercel` installed (`npm i -g vercel`).

## 1. Link the project

```bash
vercel link        # pick the scope, create or select the project, accept the detected Next.js preset
```

`vercel.json` is already in the repo: the cron and the Stripe webhook's function limit (section 8).

## 2. Create the production database

In Neon, create a **new branch** (for example `production`) from the project and copy its pooled
connection string. Never point production at the dev branch `neondb`: `db:seed` and the persona load
write to whatever `DATABASE_URL` names.

## 3. Environment variables

Generate the two random secrets locally:

```bash
openssl rand -base64 32   # AUTH_SECRET
openssl rand -base64 32   # CRON_SECRET
```

| variable | secret | where to get it | differs from local |
|---|---|---|---|
| `DATABASE_URL` | yes | Neon, the production branch, pooled string | yes, new branch |
| `AUTH_SECRET` | yes | `openssl rand`, above | yes, new value |
| `AUTH_URL` | no | `https://<domain>`, no trailing slash | yes (local is `http://localhost:3000`) |
| `RESEND_API_KEY` | yes | Resend, API Keys | usually same |
| `EMAIL_FROM` | no | `Juno <hello@yourdomain>` on a domain verified in Resend (section 5) | yes, if local used the Resend test sender |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | no, but baked into the browser bundle | Cloudflare, Turnstile, the widget's site key | same widget, see section 6 |
| `TURNSTILE_SECRET_KEY` | yes | the same widget's secret key | same |
| `CLAUDE_SECRET_KEY` | yes | Anthropic console | same |
| `TYPESAFE_SECRET_KEY` | yes | TypeSafe dashboard | same |
| `VOYAGE_API_KEY` | yes | Voyage dashboard | same |
| `STRIPE_SECRET_KEY` | yes | Stripe, test mode, Developers, API keys: `sk_test_...` | same test key |
| `STRIPE_WEBHOOK_SECRET` | yes | the **production** endpoint's signing secret, section 4 | yes (`stripe listen` prints a different one locally) |
| `PUSHER_APP_ID`, `PUSHER_KEY`, `PUSHER_SECRET`, `PUSHER_CLUSTER` | `PUSHER_SECRET` only | Pusher Channels, App Keys | same app works (section 7) |
| `NEXT_PUBLIC_PUSHER_KEY`, `NEXT_PUBLIC_PUSHER_CLUSTER` | no | copies of `PUSHER_KEY` and `PUSHER_CLUSTER`, identical values | same |
| `CRON_SECRET` | yes | `openssl rand`, above | production only |
| `SEED_CREATOR_EMAIL` | no | Juno's seat address | optional |
| `SEED_ADMIN_EMAILS` | no | comma-separated admin seat addresses | optional |
| `DEMO_SEAT_PASSWORD` | yes | pick one; shared by the creator and admin seats | optional, but without it the seats cannot sign in |

`NEXT_PUBLIC_*` values are compiled into the client bundle at build time, so set them **before** the
first deploy and redeploy after changing them. `.env.example` lists the same names with comments.

Set each one for the Production environment (the command prompts for the value, so it never lands in
shell history):

```bash
vercel env add DATABASE_URL production
vercel env add AUTH_SECRET production
# ...one per row above
```

Check the set before deploying. Put the values in a scratch file outside the repo (or run
`vercel env pull /tmp/prod.env --environment=production`), then:

```bash
npm run check:env -- /tmp/prod.env --production
```

It prints key names and the rule broken, never a value, and exits 1 on any problem. It requires every
variable above, an https `AUTH_URL`, a `whsec_` webhook secret, matching `NEXT_PUBLIC_PUSHER_*`, and
refuses an `sk_live_` Stripe key while the app is in test mode. Delete the scratch file afterwards.

## 4. Stripe webhook

Stripe, test mode, Developers, Webhooks, **Add endpoint**:

- URL: `https://<domain>/api/webhooks/stripe`
- Events (exactly these three, the ones `lib/wallet/topup.ts` handles):
  - `checkout.session.completed`
  - `checkout.session.async_payment_succeeded`
  - `checkout.session.async_payment_failed`
  - Add `payment_intent.succeeded` only if sim fans will top up against production: the simulator's saved-card
    top-up (`startTopupIntent`) is credited on that event.

Open the new endpoint, **Reveal** the signing secret (`whsec_...`) and set it:

```bash
vercel env add STRIPE_WEBHOOK_SECRET production
```

Only the webhook credits a wallet; the success page just shows "processing". The endpoint answers 400
to a bad signature and 500 on a real failure so Stripe retries; the event id is unique, so a retry is safe.

## 5. Resend

Resend, Domains: add and verify the sending domain (the DNS records it shows), then set `EMAIL_FROM`
to an address on it, for example `Juno <hello@yourdomain>`. Until the domain is verified Resend only
delivers to your own account address, so fans would not receive sign-in links.

## 6. Turnstile

Cloudflare, Turnstile, the widget behind `NEXT_PUBLIC_TURNSTILE_SITE_KEY`: add the production hostname
(`<domain>`, no scheme) to its **Hostnames**. Without it the widget on `/signin` fails and nobody can
request a link. Keep `localhost` in the list for local work.

## 7. Pusher

The existing Pusher Channels app works for production as is: same app id, key, secret and cluster.
Private channels are authorised by `/api/pusher/auth` on whichever host serves the page, so nothing
needs adding on the Pusher side. A separate app per environment is cleaner but not required.

## 8. Cron and function limits

`vercel.json` schedules two crons:

| path | schedule | does |
|---|---|---|
| `/api/cron/sweep` | `* * * * *` (every minute) | the engine sweep: picks up conversations whose turn did not run to completion |
| `/api/cron/sim` | `* * * * *` (every minute) | the fan simulator's rescue tick (docs/FAN-SIM.md); does nothing while config `sim.enabled` is false, which is how the seed leaves it |

Vercel calls each with `Authorization: Bearer $CRON_SECRET`; both routes answer 401 without a matching
`CRON_SECRET`, so the variable must be set. Leave `sim.enabled` false in production unless you mean to run sim fans there.

**Hobby plan limit.** Hobby allows a cron to run at most once a day, and a `vercel.json` with a faster
schedule makes the deploy fail. Either use Pro, or change the schedule to a daily one such as
`"0 6 * * *"` for the demo. With a daily sweep, a turn that is interrupted is not retried for up to a
day, so on Hobby treat the sweep as a safety net only and expect the occasional stuck reply. Trigger
it by hand when needed:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/sweep
```

**Function durations.** Routes that run the engine need more than a short default:

- `/api/cron/sweep` exports `maxDuration = 60` in its route file.
- `/chat` exports `maxDuration = 60` (fan sends run the turn after the response through `after()`).
- `/api/webhooks/stripe` is set to 30 seconds in `vercel.json` (`functions`), covering the wallet
  transaction and a slow database wake-up.
- `/admin` and `/console` actions also use `after()` for the turn; they declare no duration and take
  the platform default. Check Settings, Functions on the project if a human-sent reply ever gets cut off.

## 9. Database: migrate, seed, persona

Run these from your machine against the production branch. The shell variable wins over `.env.local`,
so set it for this shell only and confirm the host before writing anything:

```bash
export DATABASE_URL='<production Neon pooled string>'
node -e 'console.log(new URL(process.env.DATABASE_URL).host)'   # must be the production branch host, not neondb
export SEED_CREATOR_EMAIL='<juno seat address>'
export SEED_ADMIN_EMAILS='<admin1>,<admin2>'

npm run db:migrate      # applies drizzle/ ; then confirm: psql "$DATABASE_URL" -c '\dt'
npm run db:seed         # creator (handle junovale), admins, config rows, catalogue; safe to re-run
```

**Persona.** The engine speaks only with a published persona card. Load the retrieval chunks, then
publish the newest committed card (the highest `data/persona/card/v<N>.md`):

```bash
export VOYAGE_API_KEY='<voyage key>'
npm run persona:load -- --creator junovale
npm run persona:publish -- --creator junovale --card-version <N>
```

The publish command prints `card file v<N> -> stored version <M>`; re-running it changes nothing.

**Retrieval strategy.** The seed writes `retrieval.strategy = "vector"` (Voyage embeddings), the winner of the
retrieval eval (: recall@5 0.560 against full-text's 0.331), so production needs no extra step. A Voyage
error falls back to full-text for that turn.

When finished, `unset DATABASE_URL SEED_CREATOR_EMAIL SEED_ADMIN_EMAILS VOYAGE_API_KEY`.

## 10. Deploy

```bash
vercel deploy --prod
```

Open `https://<domain>`. If `AUTH_URL` was set to a custom domain that is not live yet, sign-in links
point at it, so set it to the URL that actually serves the app.

## 11. Smoke test

1. Open `/signin` in a fresh browser profile. The Turnstile widget renders. Enter a real email, solve
   it, and the one-tap link arrives (check spam on first send). Click it; `/onboarding` asks for a date
   of birth and the 18+ tick; confirm. The wallet starts with the $50 welcome credit.
2. `/chat`: send a message. A reply appears within a few seconds, with typing dots first.
3. `/wallet`: top up $10 with the Stripe test card `4242 4242 4242 4242`, any future expiry, any CVC.
   The page shows "processing", then the balance rises within seconds. In Stripe the webhook endpoint
   shows a 200 delivery. If the balance never moves, the signing secret is wrong.
4. Admin seat: on `/signin` use an address from `SEED_ADMIN_EMAILS` with `DEMO_SEAT_PASSWORD`. `/admin`
   and `/analytics` load, and the fan conversation from step 2 is listed.
5. Juno seat: sign in with `SEED_CREATOR_EMAIL` and the same password; `/console` loads.
6. Cron: Vercel, project, Settings, Cron Jobs shows `/api/cron/sweep`; after a run its log is a 200.

## 12. Rollback

- **Bad code:** Vercel, Deployments, pick the last good one, **Promote to Production** (or
  `vercel rollback`). It is instant and does not touch the database.
- **Bad env var:** `vercel env rm <NAME> production`, `vercel env add`, then redeploy
  (`NEXT_PUBLIC_*` only change on a rebuild).
- **Bad migration:** Neon keeps history; restore the production branch to a point before the migration
  (Neon, Branches, Restore), or create a new branch from that point and repoint `DATABASE_URL`.
  Migrations here only add; they are not reversed by hand.
- **Webhook misfire:** disable the endpoint in Stripe. Missed events can be resent from the event page;
  the unique event id prevents double credit.
- **Cron flooding or wrong:** remove the `crons` entry from `vercel.json` and redeploy; the engine still
  runs each turn on send.
