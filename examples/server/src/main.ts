import path from "node:path";
import { pathToFileURL } from "node:url";
import { createChatter, systemClock, type Chatter, type Deps } from "@understudy/engine";
import { sql } from "drizzle-orm";
import { buildServer } from "./app";
import { createBus, type Bus } from "./bus";
import { jsonConfigPort, readConfigFile, type ConfigFile } from "./config";
import { connect } from "./db";
import { EnvMissing, readEnv, type ServerEnv } from "./env";
import { CREATE_FLAGS_TABLE, readCatalogue, ServerHost, serverStore, type CatalogueItem } from "./host";
import { fakeProviders, realProviders } from "./providers";
import { SERVER_DIR } from "./seed";
import { createWebhook } from "./webhook";

export interface StartOptions {
  env: ServerEnv;
  /** Scripted providers instead of Claude; no model key is needed. */
  fake: boolean;
  /** Settings and catalogue; the shipped files by default, tests pass shorter delays. */
  config?: ConfigFile;
  catalogue?: CatalogueItem[];
  /** Listen on `env.port` (0 picks a free one). Without it the server only answers `app.inject`. */
  listen?: boolean;
  logger?: boolean;
}

export interface Running {
  app: ReturnType<typeof buildServer>;
  chatter: Chatter;
  bus: Bus;
  config: ConfigFile;
  /** The base URL when listening. */
  url: string | null;
  close(): Promise<void>;
}

/** Builds the engine and its host over the database in `env`, creates the tables both need, and starts the HTTP side. */
export async function startServer(opts: StartOptions): Promise<Running> {
  const { env } = opts;
  const config = opts.config ?? readConfigFile(path.join(SERVER_DIR, "config.json"));
  const catalogue = opts.catalogue ?? readCatalogue(path.join(SERVER_DIR, "catalogue.json"));
  const { db, end } = connect(env.databaseUrl);
  const configPort = jsonConfigPort(config);
  const host = new ServerHost(db, catalogue, Number(config.rows["server.cap_cents"]));
  const webhook = env.webhookUrl && env.webhookSecret ? createWebhook({ url: env.webhookUrl, secret: env.webhookSecret }) : undefined;
  const bus = createBus({ db, host, webhook });
  const providers = opts.fake ? fakeProviders(db) : await realProviders(db, env, configPort);
  const deps: Deps = { ...providers, events: bus, clock: systemClock };
  const chatter = createChatter({ db, config: configPort, host, deps });

  // The engine's tables first, then the server's own.
  await chatter.migrate();
  await db.execute(sql.raw(CREATE_FLAGS_TABLE));

  const app = buildServer({ chatter, apiKey: env.apiKey, bus, store: serverStore(db), logger: opts.logger });
  // The safety net behind the per-send trigger: expired leases, stragglers, expired offers.
  const sweeper = setInterval(() => {
    chatter.sweep().catch((e) => app.log.error({ errorClass: (e as Error)?.name }, "sweep failed"));
  }, 30_000);
  sweeper.unref();
  let url: string | null = null;
  if (opts.listen) {
    await app.listen({ port: env.port, host: "127.0.0.1" });
    const addr = app.server.address();
    url = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : null;
  }
  return {
    app,
    chatter,
    bus,
    config,
    url,
    async close() {
      clearInterval(sweeper);
      bus.close();
      await app.close();
      await webhook?.idle();
      await end();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fake = process.argv.includes("--fake");
  try {
    const env = readEnv(process.env, { fake });
    const migrateOnly = process.argv.includes("--migrate-only");
    startServer({ env, fake, listen: !migrateOnly, logger: true }).then(async (s) => {
      if (migrateOnly) {
        console.log("migrated");
        await s.close();
        return;
      }
      console.log(`understudy server listening on ${s.url}${fake ? " (scripted providers)" : ""}`);
      const stop = () => void s.close().then(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    }).catch((e) => {
      console.error("server failed to start:", (e as { code?: string; name?: string }).code ?? (e as Error).name);
      process.exit(1);
    });
  } catch (e) {
    console.error(e instanceof EnvMissing ? `server: ${e.message}` : "server: bad environment");
    process.exit(1);
  }
}
