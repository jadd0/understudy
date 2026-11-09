// Shared by the server's tests: a running server over the test database with scripted providers and short delays.
import { randomUUID } from "node:crypto";
import { readConfigFile } from "./config";
import { connect } from "./db";
import { readEnv } from "./env";
import { readCatalogue } from "./host";
import { startServer, type Running } from "./main";
import { SERVER_DIR, seedPersona } from "./seed";
import path from "node:path";

export const API_KEY = "test-key-0123456789abcdef";

/** Short pauses so a turn takes tens of milliseconds; `typing_cps` is raised per test that wants a visible delay. */
export const QUICK = { "engine.debounce_ms": 20, "engine.typing_cps": 4000, "delivery.bubble_gap_ms_min": 1, "delivery.bubble_gap_ms_max": 2, "engine.typing_max_ms": 50 };

export interface TestServer extends Running {
  creatorId: string;
  /** Items of the creator's catalogue (ids for offers). */
  apiKey: string;
}

/** Starts a server for a fresh creator (own persona, own catalogue) so test files do not share rows; call it once per file. */
export async function testServer(opts: { rows?: Record<string, unknown>; env?: Record<string, string | undefined>; listen?: boolean } = {}): Promise<TestServer> {
  const base = readConfigFile(path.join(SERVER_DIR, "config.json"));
  const creatorId = randomUUID();
  const config = { creatorId, rows: { ...base.rows, ...QUICK, ...opts.rows } };
  const catalogue = readCatalogue(path.join(SERVER_DIR, "catalogue.json")).map((i) => ({ ...i, id: randomUUID(), creatorId }));
  const env = readEnv({ DATABASE_URL: process.env.DATABASE_URL, UNDERSTUDY_API_KEY: API_KEY, PORT: "0", ...opts.env }, { fake: true });
  const { db, end } = connect(env.databaseUrl);
  await seedPersona(db, creatorId, undefined, { scripted: true });
  await end();
  const running = await startServer({ env, fake: true, config, catalogue, listen: opts.listen });
  return { ...running, creatorId, apiKey: API_KEY };
}

export const auth = { authorization: `Bearer ${API_KEY}` };
