import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import type { EngineDb } from "@understudy/engine";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

/** A drizzle client over the Neon WebSocket pool, so the engine's transactions are interactive. `end` closes the pool. */
export function connect(connectionString: string): { db: EngineDb; end: () => Promise<void> } {
  const pool = new Pool({ connectionString });
  return { db: drizzle(pool) as unknown as EngineDb, end: () => pool.end() };
}
