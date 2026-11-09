# @understudy/providers

The adapters behind the ports of `@understudy/engine`. A host constructs them and hands them to the engine as its
`Deps`. The package ships TypeScript source; the entry is `src/index.ts`, and nothing outside the package imports a
path inside it. It imports nothing from the app and reaches the engine only through `@understudy/engine` and
`@understudy/engine/schema`.

| Adapter | Port | Needs |
|---|---|---|
| `TypeSafeDecider` | `Decider`: Jev by REST | `apiKey` and `model` options; throws `TypeSafeNotConfigured` without them |
| `ClaudeDecider` | `Decider`: a forced tool call on Claude | `authToken` and `model` options |
| `AnthropicGenerator` | `Generator`: Claude by the official SDK | `authToken` option; `timeoutMs`, `maxRetries` |
| `FailoverDecider`, `FailoverGenerator` | `Decider`, `Generator`: try each entry in order, skip one whose breaker is open | a list of named providers and `BreakerOptions` |
| `Breaker` | the circuit breaker each failover entry sits behind | `failures`, `windowMs`, `cooldownMs` |
| `PersonaRetriever` | `Retriever`: full-text, vector or hybrid by strategy, full-text if Voyage fails | an `EngineDb`, a strategy (`parseStrategy`) and an embed function |
| `FtsRetriever` | `Retriever`: Postgres full-text only | an `EngineDb` |
| `embed` | Voyage embeddings over HTTP | `VOYAGE_API_KEY` in the environment, or the `apiKey` option |
| `noopEvents` | `Events`: drops every event | nothing |

Retrievers take their database as a constructor argument; no adapter reads a module-level connection.

## Configuration

The adapters read no settings of their own. The host reads the rows and passes the values in. The app's
`examples/app/lib/host/deps.ts` builds the failover pair from `jev.model`, the decide and draft fallback models, and the breaker
rows `breaker.failures`, `breaker.window_ms` and `breaker.cooldown_ms`, and builds `PersonaRetriever` from
`retrieval.strategy` and `retrieval.voyage_model`. Each row is described in the app's `docs/operations/CONFIG.md`.

Stripe and Pusher stay in the app: they serve its wallet and realtime, not a port a headless host needs.
