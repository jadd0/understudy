# Understudy example server

A headless host for the Understudy engine, written with Fastify. It takes a fan's message over HTTP, streams Juno's
reply bubbles back over server-sent events, lets a human take the chat over and hand it back, and posts every event to
a signed webhook. There is no UI, no wallet and no user table: it exists to show the engine runs outside the Next app.

## Run it in five commands

```bash
npm install
export DATABASE_URL=... UNDERSTUDY_API_KEY=... CLAUDE_SECRET_KEY=...   # a Neon database, or (running from source, not in the container) Postgres with pgvector behind Neon's WebSocket proxy (docker-compose.yml runs one); any long random key
npm run --workspace @jadd0/understudy-example-server migrate                 # the engine's tables and the server's own
npm run --workspace @jadd0/understudy-example-server seed                    # Juno's published card and chunks (full-text retrieval)
npm run server:dev                                                     # http://127.0.0.1:8787
```

Without a Claude key, start it with `--fake` for scripted replies. A `DATABASE_URL` on `localhost` is reached through the compose proxy (port 4454, or `NEON_LOCAL_PROXY_PORT`); any other host is a Neon database. The fifth command is a request:
`curl -H "authorization: Bearer $UNDERSTUDY_API_KEY" -d '{...}'` against `POST /v1/messages` (see below).

Play the scripted conversation without a UI:

```bash
npm run server:demo -- --fake                 # starts an in-process server on scripted replies (seconds)
npm run server:demo -- --fake --realtime      # the same at the configured typing pace (about two minutes)
npm run server:demo -- --url http://127.0.0.1:8787   # against a running server; needs UNDERSTUDY_API_KEY
```

The demo sends the eight lines of `demo-script.txt` as one fan, prints each bubble with the wait before it, takes the
conversation over as Juno after line six (`--takeover-after N`), sends a line as her, hands back, and exits 0.

## API

All bodies are JSON. Send `authorization: Bearer <UNDERSTUDY_API_KEY>`; a missing or wrong key is `401`. The key is
compared in constant time.

| Request | Does |
|---|---|
| `GET /health` | `{ "ok": true }`, no key needed |
| `POST /v1/messages` `{ creatorId, fanId, body, clientMsgId }` | Stores the message and starts the turn without waiting for it. `202 { conversationId, messageId, duplicate }`. The same `clientMsgId` returns `duplicate: true` and runs no second turn. `422 { code }` for `empty`, `too_long`, `bad_id`, `not_owner`; `403 { code: "restricted" }` for a flagged fan |
| `GET /v1/conversations/:id/events` | A server-sent event stream. `message` `{ id, sender, body, offer? }` when a bubble is due, `typing` `{ holdMs }`, `mode` `{ mode }` after a takeover or hand-back; a comment heartbeat every 15 s |
| `POST /v1/conversations/:id/takeover` `{ actorId, side, creatorId? }` | A human takes the chat. `side` is `creator` (needs `creatorId`, her own non-T&S chats only) or `ts`. `204`; `409 { code: "not_allowed" }`; `404` for an unknown chat |
| `POST /v1/conversations/:id/human-messages` `{ actorId, side, creatorId?, body, clientMsgId? }` | The human's own message, only in a chat that actor holds. `201 { messageId }`; `409` otherwise |
| `POST /v1/conversations/:id/hand-back` | Gives the chat back to the AI. `204` |

A stream shows what happens after it connects: open it before sending, or right after the first `202`. An offer rides
on the last bubble as `offer: { id, itemId, title, priceCents }`; paying for it is the calling product's job.

## Webhook

With `WEBHOOK_URL` and `WEBHOOK_SECRET` set, every engine event (`message.created`, `typing`, `conversation.mode`,
`inbox.changed`) and `message.delivered` is POSTed as JSON, with `x-understudy-signature: sha256=<hex>` where the hex is
the HMAC-SHA256 of the raw request body under the secret. Check it against the raw bytes, not a re-serialised object:

```js
import { createHmac, timingSafeEqual } from "node:crypto";
const expected = "sha256=" + createHmac("sha256", process.env.WEBHOOK_SECRET).update(rawBody).digest("hex");
const ok = expected.length === header.length && timingSafeEqual(Buffer.from(expected), Buffer.from(header));
```

A delivery is tried three times with backoff and then dropped; a 5 s timeout means a hung endpoint never holds a turn or
a stream.

## Configuration

| Variable | |
|---|---|
| `DATABASE_URL`, `UNDERSTUDY_API_KEY` | required |
| `CLAUDE_SECRET_KEY` | required unless `--fake` |
| `TYPESAFE_SECRET_KEY` | optional; Jev decides first when set, Claude behind it |
| `GATEWAY_URL`, `GATEWAY_KEY` | optional; llm-gateway goes first when the `gateway.*.enabled` rows in `config.json` are true (see `packages/providers/README.md`) |
| `WEBHOOK_URL`, `WEBHOOK_SECRET` | optional, together |
| `PORT` | default 8787 |

The engine's settings come from `config.json` (the same values the app seeds) and the catalogue from
`catalogue.json`; both are synthetic.

## What it does not do

- No sign-in beyond the one API key, and no user table: fans and creators are ids the caller supplies. Age assurance is
  the calling product's job. The engine still detects a minor in the chat, stops, and the server then refuses that fan.
- No wallet. Offers are emitted; nobody pays, unlocks or tips here. Settlement belongs to the host.
- No replay: a stream carries bubbles from the moment it connects.
- One creator's persona per database, loaded by `seed`.
