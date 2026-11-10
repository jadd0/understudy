# @jadd0/understudy-providers

The adapters behind the ports of `@jadd0/understudy-engine`. A host constructs them and hands them to the engine as its
`Deps`. The package ships TypeScript source; the entry is `src/index.ts`, and nothing outside the package imports a
path inside it. It imports nothing from the app and reaches the engine only through `@jadd0/understudy-engine` and
`@jadd0/understudy-engine/schema`.

| Adapter | Port | Needs |
|---|---|---|
| `TypeSafeDecider` | `Decider`: Jev by REST | `apiKey` and `model` options; throws `TypeSafeNotConfigured` without them |
| `ClaudeDecider` | `Decider`: a forced tool call on Claude | `authToken` and `model` options |
| `AnthropicGenerator` | `Generator`: Claude by the official SDK | `authToken` option; `timeoutMs`, `maxRetries` |
| `GatewayGenerator` | `Generator`: llm-gateway's OpenAI-compatible `/v1/chat/completions` | `baseUrl`, a `keyFor` resolver, `timeoutMs` |
| `GatewayDecider` | `Decider`: the same choice question as one forced OpenAI function tool, through llm-gateway | `baseUrl`, a `keyFor` resolver, a `model` on an OpenAI-format upstream, `timeoutMs` |
| `envKeyResolver` | the `keyFor` resolver: reads the `gateway.key_env` row (a creator's row over the platform row) and the environment variable it names | a `ConfigPort` and an environment |
| `FailoverDecider`, `FailoverGenerator` | `Decider`, `Generator`: try each entry in order, skip one whose breaker is open | a list of named providers and `BreakerOptions` |
| `Breaker` | the circuit breaker each failover entry sits behind | `failures`, `windowMs`, `cooldownMs` |
| `PersonaRetriever` | `Retriever`: full-text, vector or hybrid by strategy, full-text if Voyage fails | an `EngineDb`, a strategy (`parseStrategy`) and an embed function |
| `FtsRetriever` | `Retriever`: Postgres full-text only | an `EngineDb` |
| `embed` | Voyage embeddings over HTTP | `VOYAGE_API_KEY` in the environment, or the `apiKey` option |
| `noopEvents` | `Events`: drops every event | nothing |

Retrievers take their database as a constructor argument; no adapter reads a module-level connection.

The engine passes the creator the call is for (`creatorId`) to every `generate` and `ask`. The Claude, Jev and retrieval
adapters ignore it; the gateway adapters use it to pick that creator's key.

## Configuration

The adapters read no settings of their own. The host reads the rows and passes the values in. The app's
`examples/app/lib/host/deps.ts` builds the failover pair from `jev.model`, the decide and draft fallback models, and the breaker
rows `breaker.failures`, `breaker.window_ms` and `breaker.cooldown_ms`, and builds `PersonaRetriever` from
`retrieval.strategy` and `retrieval.voyage_model`. Each row is described in the app's `docs/operations/CONFIG.md`.

Stripe and Pusher stay in the app: they serve its wallet and realtime, not a port a headless host needs.

## Through llm-gateway

`GatewayGenerator` and `GatewayDecider` send each call to an llm-gateway instance (a separate project) instead of to
Anthropic or TypeSafe. The point is that the gateway can then hold a monthly budget, a rate limit and a request log
per creator, which a direct call cannot. They use plain `fetch` (no SDK, no new dependency), speak
`POST <GATEWAY_URL>/v1/chat/completions`, and are off by default.

Setup:

1. In the gateway, create one tenant and one key per creator (`npm run keys -- create-tenant <creator>`, then
   `create-key <creator>`), and set the tenant's budget there.
2. Put each key in the host's environment under a name of your choice, for example `GATEWAY_KEY_JUNO`. Keys are never
   stored in the database.
3. Set the creator's `gateway.key_env` row to that name. A creator with no row of their own uses the platform row, whose
   default is `GATEWAY_KEY`. A row that names a variable with no value means no key for that creator: their calls skip
   the gateway and go to Claude directly, they do not borrow the platform key.
4. Set `GATEWAY_URL` (the gateway's origin, with no `/v1`) and switch on `gateway.generate.enabled` and/or
   `gateway.decide.enabled` (platform rows; a creator's row for them is ignored). Both are `false` until you do.

| Row | Default | Meaning |
|---|---|---|
| `gateway.generate.enabled` | `false` | drafts and memory calls go through the gateway first |
| `gateway.decide.enabled` | `false` | choice questions go through the gateway first |
| `gateway.decide_model` | `"gpt-5-mini"` | the model asked for choice questions; it must route to an OpenAI-format upstream |
| `gateway.key_env` | `"GATEWAY_KEY"` | the environment variable that holds the key; set it per creator |
| `gateway.timeout_ms` | `30000` | per call |

The gateway entry goes first in its failover chain and the direct providers stay behind it. A gateway outage, a 402 when
a creator's budget is spent, a 429, or a creator with no key therefore ends in the path that runs today, not in a missing
reply. An error carries `http_<status>`, `timeout`, `network`, `malformed`, `not_configured` or `key_lookup_failed`, with a gateway 402 and 429 named `gateway_budget` and `gateway_rate_limited`, and never a response body or a
key. The signals that belong to one creator are skipped without counting against the entry's circuit breaker: no key
(`not_configured`), a spent budget (`gateway_budget`) and a rate limit (`gateway_rate_limited`). Every other failure,
including `key_lookup_failed` (the key could not be read), counts against it, and the breaker is shared by all creators.

What is lost on this path. Read from the gateway's Anthropic adapter (`packages/gateway/src/providers/anthropic.ts` in
llm-gateway) and its provider notes:

- **Prompt caching.** The OpenAI format has no cache marker, and the gateway's Anthropic adapter joins the system
  messages into one plain `system` string with no `cache_control`. The persona card and rules are billed as ordinary input
  on every turn, so expect a higher input cost per turn than the direct path. The gateway reports only input and output
  tokens for Anthropic models, so `cacheReadTokens` is 0 there; on an OpenAI-format upstream `cached_tokens` is read
  and taken out of the input count (cache reads are priced on their own row).
- **The thinking switch.** The direct adapter sends `thinking: disabled` (or `between_tools` on Sonnet 5.5). The gateway
  sends no `thinking` field, so the model's default applies. Haiku 5.5 thinks by default and thinking tokens count against
  `max_tokens`; the gateway drops thinking blocks from the answer, so a short reply budget can come back as empty text
  with `finish_reason: length`. The engine treats an empty draft as a failed attempt and retries, so this costs quality
  and money, not correctness. Raise `engine.max_tokens` or leave `gateway.generate.enabled` off if it shows up.
- **Forced tool choice on Claude.** The gateway refuses `tools` and `tool_choice` on its Anthropic and Gemini routes
  (400 `unsupported_parameter`). A decider through the gateway needs an OpenAI-format model, which is why
  `gateway.decide_model` is separate from `model.decide_fallback`; pointing it at a `claude-*` model makes every call
  `http_400` and the chain falls through to Jev and Claude.
- **Judgement is not the same model.** The choice probabilities come from the gateway's model, not from Jev, and are
  its own estimates; the engine's floors are tuned against Jev. Leave `gateway.decide.enabled` off until the eval has
  been run through it.
