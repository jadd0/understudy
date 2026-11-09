import type { HostPort } from "./ports/host";
import type { Clock } from "./ports/clock";
import type { ConfigPort } from "./ports/config";
import type { EngineDb } from "./ports/db";
import type { Decider } from "./ports/decider";
import type { Events } from "./ports/events";
import type { Generator } from "./ports/generator";
import type { Retriever } from "./ports/retriever";

/** The providers the engine calls out to. Everything it reads from the host's own tables comes through `HostPort`. */
export interface Deps {
  decider: Decider;
  generator: Generator;
  retriever: Retriever;
  events: Events;
  clock: Clock;
  /** Uniform in [0, 1); only the bubble gap uses it. Defaults to Math.random. */
  random?: () => number;
}

/** What `createChatter` was given, threaded through every engine function in place of module singletons. */
export interface EngineCtx {
  db: EngineDb;
  config: ConfigPort;
  /** Everything the engine reads or writes in the app's own tables: wallet, ledger, catalogue, unlocks, users. */
  host: HostPort;
  deps: Deps;
}
