# @understudy/engine

The conversation engine: the message turn (lease, debounce, routing, pacing, offers, prompt, verification and
commit), retrieval over persona chunks, the sweep that picks up unanswered conversations, and the ports it talks
through. It ships as TypeScript source with no build step; Next compiles it (`transpilePackages`) and vitest and
tsx run it directly. Private to this repository's npm workspace.

## Entry points

- `@understudy/engine`: `runTurn`, `processConversation`, `sweep`, the lease and hand-back helpers, the retrieval
  functions, the port interfaces and the engine's types.
- `@understudy/engine/testing`: `FakeDecider`, `FakeGenerator`, the in-memory `FakeHost`, the fixtures and the
  harness that runs a turn against the test database.

Nothing else inside `src/` is public. `src/boundary.test.ts` fails when code outside the package reaches past
the two entries.

## Ports

| Port | Role |
|---|---|
| `Decider` | judges a fan message and the state around it (production: Jev through TypeSafe) |
| `Generator` | writes the reply (production: Claude) |
| `Retriever` | finds persona chunks for a query |
| `Events` | realtime and delivery notifications |
| `Clock` | the time source, so tests can pin it |
| `HostPort` | everything the engine reads or writes in the host's own tables: the fan's wallet facts and cap rule, the catalogue and ownership, the users it flags. The engine never names those tables |

The adapters for the real services are not in this package; the host passes them in.

## Usage sketch

```ts
import { processConversation, systemClock, type Deps } from "@understudy/engine";

const deps: Deps = {
  decider,   // implements Decider
  generator, // implements Generator
  retriever, // implements Retriever
  events,    // implements Events
  clock: systemClock,
  host,      // implements HostPort over your wallet, ledger and catalogue
};

await processConversation(conversationId, deps);
```

In tests, build the same `Deps` from `FakeDecider`, `FakeGenerator`, `FakeHost` and `rig()` from
`@understudy/engine/testing`.

## Known limitation

The package is not yet standalone. Its source imports three things from the host app: the database client
(`@/db/client`), the table definitions (`@/db/schema`) and `getConfig` (`@/lib/config`), and the `@/` alias must
resolve to the host's root. `src/boundary.test.ts` holds the package to exactly those three. The test support
(`testing` entry, `test-*.ts`) additionally uses the host's seed data, `dbHost` and the Postgres full-text
retriever to build a world. The package will own its tables and configuration reads in a later change, which
removes these imports.
