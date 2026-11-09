import { db } from "@/db/client";
import { dbHost } from "@/lib/host/engine-host";
import {
  AnthropicGenerator,
  ClaudeDecider,
  embed,
  FailoverDecider,
  FailoverGenerator,
  parseStrategy,
  PersonaRetriever,
  TypeSafeDecider,
  withModel,
} from "@understudy/providers";
import { defaultEvents } from "@/providers/pusher/events";
import { dbConfigPort, getConfig } from "@/lib/config";
import { createChatter, systemClock, type Chatter, type Decider, type Deps, type Events } from "@understudy/engine";
import type { RetrievalStrategy } from "@understudy/providers";

type KeySource = Record<string, string | undefined>;

/** The strategy retrieval actually runs: vector and hybrid need Voyage to embed the query, so without its key it is full-text search. */
export function effectiveStrategy(configured: RetrievalStrategy, source: KeySource = process.env): RetrievalStrategy {
  return source.VOYAGE_API_KEY ? configured : "fts";
}

/** The decider chain in order: Jev first only when its key is set, Claude always. */
export function deciderEntries(
  source: KeySource,
  models: { jev: string; fallback: string },
): { name: string; decider: Decider }[] {
  const claudeToken = source.CLAUDE_SECRET_KEY ?? "";
  const entries: { name: string; decider: Decider }[] = [];
  if (source.TYPESAFE_SECRET_KEY) {
    entries.push({
      name: "jev",
      decider: new TypeSafeDecider({ apiKey: source.TYPESAFE_SECRET_KEY, model: models.jev, timeoutMs: 20_000, backoffMs: 500, fetch: globalThis.fetch }),
    });
  }
  entries.push({ name: "claude", decider: new ClaudeDecider({ authToken: claudeToken, model: models.fallback, timeoutMs: 20_000 }) });
  return entries;
}

/**
 * The production wiring: Jev by REST (when its key is set) with Claude behind it as the decider fallback, Claude by its SDK with a second
 * model behind it for drafting, retrieval by the strategy the eval chose (full-text without a Voyage key), Pusher for realtime when its keys are set. Each failover entry
 * sits behind its own circuit breaker.
 */
export async function defaultDeps(): Promise<Deps> {
  const model = await getConfig<string>("jev.model");
  const strategy = effectiveStrategy(parseStrategy(await getConfig<string>("retrieval.strategy")));
  const voyageModel = await getConfig<string>("retrieval.voyage_model");
  const { decider, generator } = await failover(model);
  return {
    decider,
    generator,
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
 * The providers of `defaultDeps`, resolved on first use. Storing a message needs no provider and no setting, so a
 * chatter built only to store never reads the model rows; one that answers reads them once, fresh for that send.
 */
function lazyDeps(): Deps {
  let resolved: Promise<Deps> | undefined;
  const get = () => (resolved ??= defaultDeps());
  return {
    decider: { ask: async (questions, context) => (await get()).decider.ask(questions, context) },
    generator: { generate: async (input) => (await get()).generator.generate(input) },
    retriever: { retrieve: async (creatorId, query, k) => (await get()).retriever.retrieve(creatorId, query, k) },
    events: { emit: async (channel, event, payload) => (await get()).events.emit(channel, event, payload) },
    clock: systemClock,
  };
}

/** The production engine. Built on every call, so a changed model row applies to the next send. */
export async function chatter(): Promise<Chatter> {
  return chatterFor(lazyDeps());
}

/** The engine for a caller that only stores or flips state, reporting to the events it is handed instead of Pusher. */
export function chatterWithEvents(events: Events): Chatter {
  return chatterFor({ ...lazyDeps(), events });
}

type Failover = Pick<Deps, "decider" | "generator">;
let shared: { key: string; value: Failover } | undefined;

/**
 * The failover wrappers are built once per server instance and reused: a breaker only works if its failure count
 * survives from one turn to the next, and `defaultDeps` runs per request. A change to a model or threshold row
 * changes the key and builds fresh ones.
 */
async function failover(model: string): Promise<Failover> {
  const decideFallbackModel = await getConfig<string>("model.decide_fallback");
  const generateFallbackModel = await getConfig<string>("model.generate_fallback");
  const breaker = {
    failures: await getConfig<number>("breaker.failures"),
    windowMs: await getConfig<number>("breaker.window_ms"),
    cooldownMs: await getConfig<number>("breaker.cooldown_ms"),
    clock: systemClock,
  };
  const key = JSON.stringify([Boolean(process.env.TYPESAFE_SECRET_KEY), model, decideFallbackModel, generateFallbackModel, breaker.failures, breaker.windowMs, breaker.cooldownMs]);
  if (shared?.key === key) return shared.value;
  const claudeToken = process.env.CLAUDE_SECRET_KEY ?? "";
  const claude = new AnthropicGenerator({ authToken: claudeToken, timeoutMs: 30_000, maxRetries: 1 });
  const value: Failover = {
    decider: new FailoverDecider(deciderEntries(process.env, { jev: model, fallback: decideFallbackModel }), breaker),
    generator: new FailoverGenerator(
      [
        { name: "claude", generator: claude },
        { name: "claude-fallback", generator: withModel(claude, generateFallbackModel) },
      ],
      breaker,
    ),
  };
  shared = { key, value };
  return value;
}
