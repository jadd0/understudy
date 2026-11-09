import { db } from "@/db/client";
import { dbHost } from "@/lib/host/engine-host";
import { getConfig } from "@/lib/config";
import { ClaudeDecider } from "@/providers/anthropic/decider";
import { AnthropicGenerator } from "@/providers/anthropic/generator";
import { FailoverDecider } from "@/providers/failover/decider";
import { FailoverGenerator, withModel } from "@/providers/failover/generator";
import { defaultEvents } from "@/providers/pusher/events";
import { embed } from "@/providers/voyage/embed";
import { parseStrategy, PersonaRetriever } from "@/providers/voyage/persona-retriever";
import { TypeSafeDecider } from "@/providers/typesafe/decider";
import { systemClock } from "@/platform/ports/clock";
import type { Deps } from "./turn";

/**
 * The production wiring: Jev by REST with Claude behind it as the decider fallback, Claude by its SDK with a second
 * model behind it for drafting, retrieval by the strategy the eval chose, Pusher for realtime. Each failover entry
 * sits behind its own circuit breaker.
 */
export async function defaultDeps(): Promise<Deps> {
  const model = await getConfig<string>("jev.model");
  const strategy = parseStrategy(await getConfig<string>("retrieval.strategy"));
  const voyageModel = await getConfig<string>("retrieval.voyage_model");
  const { decider, generator } = await failover(model);
  return {
    decider,
    generator,
    retriever: new PersonaRetriever(db, strategy, async (q) => (await embed([q], "query", { model: voyageModel, retries: 1 })).embeddings[0]),
    events: defaultEvents(),
    clock: systemClock,
    host: dbHost,
  };
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
  const key = JSON.stringify([model, decideFallbackModel, generateFallbackModel, breaker.failures, breaker.windowMs, breaker.cooldownMs]);
  if (shared?.key === key) return shared.value;
  const claudeToken = process.env.CLAUDE_SECRET_KEY ?? "";
  const claude = new AnthropicGenerator({ authToken: claudeToken, timeoutMs: 30_000, maxRetries: 1 });
  const value: Failover = {
    decider: new FailoverDecider(
      [
        {
          name: "jev",
          decider: new TypeSafeDecider({
            apiKey: process.env.TYPESAFE_SECRET_KEY ?? "",
            model,
            timeoutMs: 20_000,
            backoffMs: 500,
            fetch: globalThis.fetch,
          }),
        },
        { name: "claude", decider: new ClaudeDecider({ authToken: claudeToken, model: decideFallbackModel, timeoutMs: 20_000 }) },
      ],
      breaker,
    ),
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
