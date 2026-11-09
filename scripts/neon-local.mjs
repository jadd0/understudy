// Points the @neondatabase/serverless driver at the local WebSocket proxy (docker-compose.yml) when a connection
// string names a local host. The driver keeps one global config, so calling this once per process covers every
// Pool that process opens. A hosted connection string leaves the config untouched.
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";

/** The local test base when TEST_DATABASE_BASE_URL is not set: the compose Postgres, through the proxy. */
export const DEFAULT_LOCAL_BASE = "postgres://postgres:postgres@localhost:5437/understudy";
/** Host port of the compose WebSocket proxy. */
export const LOCAL_PROXY_PORT = Number(process.env.NEON_LOCAL_PROXY_PORT ?? 4454);

export function isLocalHost(hostname) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
}

/** Configures the driver for the local proxy when `url` is local; returns whether it did. */
export function useLocalNeon(url) {
  neonConfig.webSocketConstructor ??= ws;
  if (!url || !isLocalHost(new URL(url).hostname)) return false;
  neonConfig.wsProxy = (host) => `${host}:${LOCAL_PROXY_PORT}/v2`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
  return true;
}
