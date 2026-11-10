# @jadd0/understudy-engine

The conversation engine: the message turn (lease, debounce, routing, pacing, offers, prompt, verification and
commit), retrieval over persona chunks, the sweep that picks up unanswered conversations, and the ports it talks
through. It builds to ES modules with type declarations (`npm run build`, plain `tsc`), needs Node 22 or newer, and
takes `drizzle-orm` and `@neondatabase/serverless` as peer dependencies.

```sh
npm install @jadd0/understudy-engine drizzle-orm @neondatabase/serverless
```

## Entry points

- `@jadd0/understudy-engine`: `createUnderstudy` and the `Understudy` it returns (`migrate`, `setCreatorAi`,
  `creatorAi`, `handleMessage`, `processConversation`, `runTurn`, `sweep`, `handBack`, `takeOver`, `humanReply`,
  `expireOffers`), the errors and limits a host shares with the engine, the retrieval functions, the port
  interfaces and the engine's types. Nothing else is a value export.
- `@jadd0/understudy-engine/schema`: the engine's tables and enums.
- `@jadd0/understudy-engine/fakes`: `FakeDecider` and `FakeGenerator`, scripted stand-ins for the two model ports.

This repository's own tests and apps also reach two workspace-only entries that the published package does not
carry: `@jadd0/understudy-engine/testing` (the in-memory `FakeHost`, the fixtures and the harness that runs a turn
against the test database) and `@jadd0/understudy-engine/internal` (functions such as `loadFacts` and
`loadEngineConfig`). `workspace-sources.json` maps every entry to its source file.

Nothing else inside `src/` is public. `src/ports/boundary.test.ts` fails when code outside the package reaches past
the entries, and `src/index.test.ts` fails when the public entry gains or loses an export.

## Layout

`src/` is grouped by area; a test sits beside the file it tests.

```
src/
  index.ts  understudy.ts  ctx.ts  types.ts      the public entry, the understudy factory, the context, shared types
  internal.ts                                 the workspace-only entry (not published)
  testing.ts  fakes.ts                        the entries for tests (re-export from testing/)
  ports/         the seams: clock, config, db, decider, events, generator, retriever, host
  db/            schema.ts (tables and enums), migrate.ts
  config/        load.ts: getConfig and loadEngineConfig over the config table
  turn/          the message turn, in the order it runs
                 run.ts (runTurn and the attempt loop), inbound.ts (what the fan wrote), debounce.ts,
                 facts.ts, draft.ts (retry notes), pass.ts (pass types), commit.ts + record.ts + plan.ts
                 (the one-transaction commit), deliver.ts, cost.ts, result.ts, process.ts
  routing/       route.ts (Jev's reading to a route), pacing.ts, questions.ts
  drafting/      prompt.ts, thread.ts, memory.ts, emoji.ts, templates.ts, verify.ts, bubbles.ts
  retrieval/     retrieve.ts: full-text, vector and hybrid search over persona chunks
  conversation/  lifecycle: lease.ts, handoff.ts, takeover.ts, escalation.ts, sweep.ts, offer.ts, events.ts,
                 creator-settings.ts, strikes.ts
  testing/       fakes/ (decider, generator), fake-host.ts, harness.ts, db.ts, fixtures.ts
```

## Quick start (headless)

A fan writes to a creator and the engine answers, with scripted providers and no network call. It needs Postgres
with pgvector (`docker compose up -d` in this repository) and a `config.json` next to it (a copy of
`examples/server/config.json`).

<!-- quickstart: scripts/pack-smoke/quickstart.mjs -->
```js
// A fan writes to a creator and the engine answers, with scripted providers and no network call.
// Needs Postgres with pgvector (`docker compose up -d`) and DATABASE_URL pointing at an empty database.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import { createUnderstudy, systemClock } from "@jadd0/understudy-engine";
import { FakeDecider, FakeGenerator } from "@jadd0/understudy-engine/fakes";
import { messages, personaCards } from "@jadd0/understudy-engine/schema";
import { FtsRetriever, noopEvents } from "@jadd0/understudy-providers";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

// The Neon driver talks WebSocket; a local Postgres is reached through the compose proxy.
neonConfig.webSocketConstructor = ws;
if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(url).hostname)) {
  neonConfig.wsProxy = (host) => `${host}:${process.env.NEON_LOCAL_PROXY_PORT ?? 4454}/v2`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
}
const pool = new Pool({ connectionString: url });
const db = drizzle(pool);

// Settings come from a file next to this one (a copy of examples/server/config.json); the delays are shortened so
// the reply arrives in a moment. A real host reads a `config` table.
const FAST = { "engine.debounce_ms": 50, "engine.typing_cps": 400, "delivery.bubble_gap_ms_min": 20, "delivery.bubble_gap_ms_max": 60, "engine.typing_max_ms": 300 };
const rows = { ...JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8")).rows, ...FAST };
const config = {
  async rows(q) {
    return Object.entries(rows)
      .filter(([key]) => q.keys.includes(key) || q.prefixes.some((p) => key.startsWith(p)))
      .map(([key, value]) => ({ key, value, creatorId: null }));
  },
};

// The host's side: this one has no wallet and no catalogue, so nothing is ever offered.
const host = {
  fanFacts: async () => ({ spentTodayCents: 0, capCents: 0, atCap: true, unlocksInWindow: 0, highValue: false }),
  capAllows: () => false,
  catalogue: { shortlist: async () => [], ownedShortlist: async () => [], ownsEverything: async () => false },
  items: async () => new Map(),
  owns: async () => new Set(),
  flagFan: async () => {},
};

// Scripted providers: calm answers to every question, and a canned reply to the fan.
const no = { value: "no", probabilities: { yes: 0.02, no: 0.98 } };
const decider = new FakeDecider({
  script: {
    intent: { value: "smalltalk", probabilities: { smalltalk: 0.9 } },
    explicitness: "none",
    minor: no,
    self_harm: no,
    threat: no,
    location_offplatform: no,
    payment_dispute: no,
    hardship: no,
    thread: "same_topic",
    pitch_fit: { value: "yes", probabilities: { yes: 0.95, no: 0.05 } },
    reasks: "no",
    offer_response: "na",
    on_persona: "yes",
    offplatform_or_meetup: "no",
    is_refusal: "no",
    admits_ai: "no",
    promises_price_or_free: "no",
    leads_to_offer: "no",
  },
});
const generator = new FakeGenerator({
  replies: [(input) => (input.system.cached.startsWith("Extract facts") ? "{}" : "hey! long day but better now you're here")],
});

const understudy = createUnderstudy({
  db,
  config,
  host,
  deps: { decider, generator, retriever: new FtsRetriever(db), events: noopEvents, clock: systemClock },
});

await understudy.migrate();

const creatorId = randomUUID();
const fanId = randomUUID();
await db.insert(personaCards).values({ creatorId, version: 1, body: "Warm, quick, a little teasing.", publishedAt: new Date() });

const { conversationId, process: answer } = await understudy.handleMessage({ creatorId, fanId, body: "hey, how was your day?", clientMsgId: randomUUID() });
await answer();

const answers = await db.select({ body: messages.body, sender: messages.sender }).from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt));
const ai = answers.filter((m) => m.sender === "ai");
for (const m of ai) console.log(`reply: ${m.body}`);
await pool.end();
if (ai.length === 0) process.exit(1);
```

`npm run pack:smoke` installs the packed tarballs into a scratch project and runs this very file.

## Ports

| Port | Role |
|---|---|
| `Decider` | judges a fan message and the state around it (production: Jev through TypeSafe) |
| `Generator` | writes the reply (production: Claude) |
| `Retriever` | finds persona chunks for a query |
| `Events` | realtime and delivery notifications |
| `Clock` | the time source, so tests can pin it |
| `ConfigPort` | reads `config` rows; the engine decides precedence and never lets a creator row loosen a `floor.` or `platform.` key |
| `HostPort` | everything the engine reads or writes in the host's own tables: the fan's wallet facts and cap rule, the catalogue and ownership, the users it flags. The engine never names those tables |

The adapters for the real services are in `@jadd0/understudy-providers`; the host passes them in.

## Usage sketch

```ts
import { createUnderstudy, systemClock } from "@jadd0/understudy-engine";

const understudy = createUnderstudy({
  db,     // a drizzle client over the Neon WebSocket pool
  config, // implements ConfigPort over your `config` table; a missing row fails closed (ConfigMissing)
  host,   // implements HostPort over your wallet, ledger and catalogue
  deps: {
    decider,   // implements Decider
    generator, // implements Generator
    retriever, // implements Retriever
    events,    // implements Events
    clock: systemClock,
  },
});

// Store a fan's message; the host decides when to run the step that answers it.
const { process, conversationId } = await understudy.handleMessage({ creatorId, fanId, body, clientMsgId });
await process();

await understudy.sweep(); // the safety net, from a cron
```

`handleMessage` throws `MessageRefused` (`empty`, `too_long`, `bad_id`, `not_owner`) and stores nothing. Who may
send is the host's check, made before the call.

Without a model, build the same wiring from `FakeDecider` and `FakeGenerator` (`@jadd0/understudy-engine/fakes`). In
this repository's own tests, `rig()` from the workspace-only `@jadd0/understudy-engine/testing` also returns a ready
understudy over the test database.

## Tables and migrations

The engine owns its tables (`conversations`, `messages`, `turns`, `offers`, `handoffs`, `fan_memory`, `persona_cards`,
`persona_chunks`, `creator_settings`), defined in `@jadd0/understudy-engine/schema`. They live in the `public` Postgres
schema and know host rows (users, creators, catalogue items) by id only: those columns carry no foreign key, so the
package creates its tables on a database that has none of the host's.

The package ships its own migrations in `drizzle/`, recorded in `drizzle.__understudy_engine_migrations`. A host
applies them with `understudy.migrate()` before its own migrations, because the host's tables may point foreign keys
at the engine's. The call takes a session advisory lock and is safe to repeat. Maintainers regenerate them with
`npx drizzle-kit generate` in the package folder.

## The AI switch

`creator_settings` holds one row per creator that has switched the AI off or on. A creator with no row is on.
`understudy.setCreatorAi(creatorId, on)` upserts it and `understudy.creatorAi(creatorId)` reads it; the lease's claim reads
the table in the same statement that takes the conversation.

## Known limitation

The workspace-only `testing` entry (and the files behind it) still uses the host's seed data, `dbHost` and the Postgres full-text
retriever to build a world.
