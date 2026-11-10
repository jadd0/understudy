// The engine's public entry: the factory a host calls, the ports it implements, and the errors and limits it shares.

export { createUnderstudy, MAX_CLIENT_MSG_ID_CHARS, MAX_MESSAGE_CHARS, MessageRefused } from "./understudy.js";
export type { HandledMessage, IncomingMessage, MessageRefusedCode, Understudy, UnderstudyOptions } from "./understudy.js";
export type { Deps } from "./ctx.js";
export { TIP_ROW_PREFIX } from "./conversation/events.js";
export type { FlagReason, HostFanFacts, HostItem, HostPort, HostTx, ShortlistItem, ShortlistKind, ShortlistQuery } from "./ports/host.js";
export type { Clock } from "./ports/clock.js";
export { systemClock } from "./ports/clock.js";
export { ConfigMissing } from "./ports/config.js";
export type { ConfigPort, ConfigRow } from "./ports/config.js";
export type { EngineDb, EngineTx } from "./ports/db.js";
export { DeciderUnavailable, TypeSafeNotConfigured } from "./ports/decider.js";
export type { Answer, Decider, DeciderContext, DeciderResult, DeciderState, Question } from "./ports/decider.js";
export type { Events } from "./ports/events.js";
export { GeneratorError } from "./ports/generator.js";
export type { GenerateInput, GenerateMessage, GenerateResult, GenerateUsage, Generator } from "./ports/generator.js";
export type { Chunk, Retriever } from "./ports/retriever.js";
export { retrieveFts, retrieveHybrid, retrieveVector } from "./retrieval/retrieve.js";
export type { Hit, RetrieveDeps } from "./retrieval/retrieve.js";
export { MAX_HUMAN_BODY_CHARS, TakeoverRefused } from "./conversation/takeover.js";
export type { HumanActor, TakeoverRefusedCode } from "./conversation/takeover.js";
export type { SweepResult } from "./conversation/sweep.js";
export type { TurnResult } from "./turn/result.js";
