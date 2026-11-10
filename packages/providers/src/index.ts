// The adapters that implement the engine's ports. A host imports from here, never from a folder inside.

export { ClaudeDecider } from "./anthropic/decider.js";
export type { ClaudeDeciderOptions } from "./anthropic/decider.js";
export { AnthropicGenerator, thinkingOff } from "./anthropic/generator.js";
export type { AnthropicGeneratorOptions } from "./anthropic/generator.js";
export { Breaker } from "./failover/breaker.js";
export type { BreakerOptions } from "./failover/breaker.js";
export { FailoverDecider } from "./failover/decider.js";
export { FailoverGenerator, withModel } from "./failover/generator.js";
export { GatewayDecider } from "./gateway/decider.js";
export type { GatewayDeciderOptions } from "./gateway/decider.js";
export { GatewayGenerator } from "./gateway/generator.js";
export type { GatewayGeneratorOptions } from "./gateway/generator.js";
export { envKeyResolver, GATEWAY_KEY_ROW } from "./gateway/keys.js";
export type { GatewayKeyResolver } from "./gateway/keys.js";
export { noopEvents } from "./noop/events.js";
export { FtsRetriever } from "./pg/fts-retriever.js";
export { TypeSafeDecider } from "./typesafe/decider.js";
export type { TypeSafeDeciderOptions } from "./typesafe/decider.js";
export { embed, VoyageError } from "./voyage/embed.js";
export type { EmbedResult, VoyageInputType, VoyageOptions } from "./voyage/embed.js";
export { parseStrategy, PersonaRetriever } from "./voyage/persona-retriever.js";
export type { RetrievalStrategy } from "./voyage/persona-retriever.js";
