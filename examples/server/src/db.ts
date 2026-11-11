import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import type { EngineDb } from "@jadd0/understudy-engine";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * The driver settings that reach a local Postgres through Neon's WebSocket proxy (docker-compose.yml runs one on
 * port 4454, or `NEON_LOCAL_PROXY_PORT`, an empty value counting as unset), on the URL's own host (so a `127.0.0.1` or `[::1]` URL is not redirected to `localhost`), or `null` for any other host, which
 * keeps the driver's defaults.
 */
export function localProxy(url: string, env: Record<string, string | undefined> = process.env) {
  const { hostname } = new URL(url);
  if (!LOCAL_HOSTS.has(hostname)) return null;
  return {
    wsProxy: `${hostname}:${env.NEON_LOCAL_PROXY_PORT?.trim() || 4454}/v2`,
    useSecureWebSocket: false,
    pipelineTLS: false,
    pipelineConnect: false,
  };
}

/**
 * A Neon pool whose connections carry the local-proxy settings on themselves, never on the process-wide `neonConfig`:
 * a hosted pool made later in the same process keeps the driver's defaults.
 */
export function createPool(connectionString: string, env: Record<string, string | undefined> = process.env): Pool {
  const pool = new Pool({ connectionString });
  const local = localProxy(connectionString, env);
  if (local) {
    const Base = pool.Client;
    pool.Client = class LocalClient extends Base {
      constructor(config?: ConstructorParameters<typeof Base>[0]) {
        super(config);
        Object.assign(this.neonConfig, local);
      }
    };
  }
  return pool;
}

/** A drizzle client over the Neon WebSocket pool, so the engine's transactions are interactive. `end` closes the pool. */
export function connect(connectionString: string): { db: EngineDb; end: () => Promise<void> } {
  const pool = createPool(connectionString);
  return { db: drizzle(pool) as unknown as EngineDb, end: () => pool.end() };
}
