import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import type { EngineDb } from "@understudy/engine";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * The driver settings that reach a local Postgres through Neon's WebSocket proxy (docker-compose.yml runs one on
 * port 4454, or `NEON_LOCAL_PROXY_PORT`), or `null` for any other host, which keeps the driver's defaults.
 */
export function localProxy(url: string, env: Record<string, string | undefined> = process.env) {
  if (!LOCAL_HOSTS.has(new URL(url).hostname)) return null;
  return {
    wsProxy: `localhost:${env.NEON_LOCAL_PROXY_PORT ?? 4454}/v2`,
    useSecureWebSocket: false,
    pipelineTLS: false,
    pipelineConnect: false,
  };
}

/** A drizzle client over the Neon WebSocket pool, so the engine's transactions are interactive. `end` closes the pool. */
export function connect(connectionString: string): { db: EngineDb; end: () => Promise<void> } {
  const local = localProxy(connectionString);
  if (local) Object.assign(neonConfig, local);
  const pool = new Pool({ connectionString });
  return { db: drizzle(pool) as unknown as EngineDb, end: () => pool.end() };
}
