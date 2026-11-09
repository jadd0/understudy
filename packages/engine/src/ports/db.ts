import type { NeonDatabase } from "drizzle-orm/neon-serverless";

/**
 * The database a host hands the engine: a drizzle client over the Neon WebSocket pool, so transactions are interactive.
 * The engine uses the query builder and `execute`, never `db.query.*`, so the host's schema generic does not matter.
 */
export type EngineDb = NeonDatabase<Record<string, unknown>>;

/** A transaction opened by `EngineDb`. The host receives the same object in its `HostPort` calls, so both write on one connection. */
export type EngineTx = Parameters<Parameters<EngineDb["transaction"]>[0]>[0];
