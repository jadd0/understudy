# @understudy/engine

The conversation engine: the message turn (lease, debounce, routing, pacing, offers, prompt, verification and
commit), retrieval over persona chunks, the sweep that picks up unanswered conversations, and the ports it talks
through. It ships as TypeScript source with no build step; Next compiles it (`transpilePackages`) and vitest and
tsx run it directly. Private to this repository's npm workspace.

## Entry points

- `@understudy/engine`: `createChatter` and the `Chatter` it returns, `handBack` and `supersedeUnseenBubbles` (which
  need only a database), the retrieval functions, the port interfaces and the engine's types.
- `@understudy/engine/schema`: the engine's tables and enums.
- `@understudy/engine/testing`: `FakeDecider`, `FakeGenerator`, the in-memory `FakeHost`, the fixtures and the
  harness that runs a turn against the test database.

Nothing else inside `src/` is public. `src/boundary.test.ts` fails when code outside the package reaches past
the published entries.

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

The adapters for the real services are not in this package; the host passes them in.

## Usage sketch

```ts
import { createChatter, systemClock } from "@understudy/engine";

const chatter = createChatter({
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
const { process, conversationId } = await chatter.handleMessage({ creatorId, fanId, body, clientMsgId });
await process();

await chatter.sweep(); // the safety net, from a cron
```

`handleMessage` throws `MessageRefused` (`empty`, `too_long`, `bad_id`, `not_owner`) and stores nothing. Who may
send is the host's check, made before the call.

In tests, build the same wiring from `FakeDecider`, `FakeGenerator`, `FakeHost` and `rig()` from
`@understudy/engine/testing`, which also returns a ready chatter.

## Tables and migrations

The engine owns its tables (`conversations`, `messages`, `turns`, `offers`, `handoffs`, `fan_memory`, `persona_cards`,
`persona_chunks`, `creator_settings`), defined in `@understudy/engine/schema`. They live in the `public` Postgres
schema and know host rows (users, creators, catalogue items) by id only: those columns carry no foreign key, so the
package creates its tables on a database that has none of the host's.

The package ships its own migrations in `examples/app/drizzle/`, recorded in `drizzle.__understudy_engine_migrations`. A host
applies them with `chatter.migrate()` (or `migrateEngine(db)` from `@understudy/engine/migrate`) before its own
migrations, because the host's tables may point foreign keys at the engine's. Both calls take a session advisory lock
and are safe to repeat. Maintainers regenerate them with `npx drizzle-kit generate` in the package folder.

## The AI switch

`creator_settings` holds one row per creator that has switched the AI off or on. A creator with no row is on.
`chatter.setCreatorAi(creatorId, on)` upserts it and `chatter.creatorAi(creatorId)` reads it; the lease's claim reads
the table in the same statement that takes the conversation.

## Known limitation

Test support (the `testing` entry, `test-*.ts`) still uses the host's seed data, `dbHost` and the Postgres full-text
retriever to build a world.
