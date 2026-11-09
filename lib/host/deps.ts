import { db } from "@/db/client";
import { dbHost } from "@/lib/host/engine-host";
import { AnthropicGenerator } from "@/providers/anthropic/generator";
import { defaultEvents } from "@/providers/pusher/events";
import { embed } from "@/providers/voyage/embed";
import { parseStrategy, PersonaRetriever } from "@/providers/voyage/persona-retriever";
import { TypeSafeDecider } from "@/providers/typesafe/decider";
import { dbConfigPort, getConfig } from "@/lib/config";
import { createChatter, systemClock, type Chatter, type Deps } from "@understudy/engine";

/** The production wiring: Jev by REST, Claude by its SDK, retrieval by the strategy the eval chose, Pusher for realtime. */
export async function defaultDeps(): Promise<Deps> {
  const model = await getConfig<string>("jev.model");
  const strategy = parseStrategy(await getConfig<string>("retrieval.strategy"));
  const voyageModel = await getConfig<string>("retrieval.voyage_model");
  return {
    decider: new TypeSafeDecider({
      apiKey: process.env.TYPESAFE_SECRET_KEY ?? "",
      model,
      timeoutMs: 20_000,
      backoffMs: 500,
      fetch: globalThis.fetch,
    }),
    generator: new AnthropicGenerator({ authToken: process.env.CLAUDE_SECRET_KEY ?? "", timeoutMs: 30_000, maxRetries: 1 }),
    retriever: new PersonaRetriever(db, strategy, async (q) => (await embed([q], "query", { model: voyageModel, retries: 1 })).embeddings[0]),
    events: defaultEvents(),
    clock: systemClock,
  };
}

/** The engine over the app's database, settings and host tables, driving the given providers. */
export function chatterFor(deps: Deps): Chatter {
  return createChatter({ db, config: dbConfigPort, host: dbHost, deps });
}

/**
 * The production engine. Built on every call, not cached: `defaultDeps` reads the model and retrieval settings, and a
 * changed row must apply to the next send.
 */
export async function chatter(): Promise<Chatter> {
  return chatterFor(await defaultDeps());
}
