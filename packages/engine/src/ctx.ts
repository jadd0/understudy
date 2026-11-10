import type { HostPort } from "./ports/host.js";
import type { Clock } from "./ports/clock.js";
import type { ConfigPort } from "./ports/config.js";
import type { EngineDb } from "./ports/db.js";
import type { Decider } from "./ports/decider.js";
import type { Events } from "./ports/events.js";
import type { Generator } from "./ports/generator.js";
import type { Retriever } from "./ports/retriever.js";

/** The providers the engine calls out to. Everything it reads from the host's own tables comes through `HostPort`. */
export interface Deps {
  decider: Decider;
  generator: Generator;
  retriever: Retriever;
  events: Events;
  clock: Clock;
  /** Uniform in [0, 1); the bubble gap and the per-reply style draw use it. Defaults to Math.random. */
  random?: () => number;
}

/** What `createUnderstudy` was given, threaded through every engine function in place of module singletons. */
export interface EngineCtx {
  db: EngineDb;
  config: ConfigPort;
  /** Everything the engine reads or writes in the app's own tables: wallet, ledger, catalogue, unlocks, users. */
  host: HostPort;
  deps: Deps;
}
