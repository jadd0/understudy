import { getConfig } from "@/lib/config";
import { defaultDeps } from "@/lib/host/deps";
import type { Deps, Generator } from "@understudy/engine";
import { AnthropicGenerator, embed } from "@understudy/providers";
import { LiveSimStripe, type SimStripe } from "./stripe";

export interface SimDeps {
  /** The engine's own wiring: Jev, Claude (voice), retrieval, events, clock. */
  engine: Deps;
  /** The sim fan's model, on `sim.model`. Never the engine's generator, so costs stay apart. */
  generator: Generator;
  stripe: SimStripe;
  /** Embeds a retrieval query for the line library; absent means the tag fallback. */
  embedQuery?: (q: string) => Promise<number[]>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

/** Production wiring: the engine's `defaultDeps()`, Haiku for the fan, live Stripe, Voyage for line retrieval. */
export async function simDeps(): Promise<SimDeps> {
  const voyageModel = await getConfig<string>("retrieval.voyage_model");
  return {
    engine: await defaultDeps(),
    generator: new AnthropicGenerator({ authToken: process.env.CLAUDE_SECRET_KEY ?? "", timeoutMs: 30_000, maxRetries: 1 }),
    stripe: new LiveSimStripe(),
    embedQuery: async (q) => (await embed([q], "query", { model: voyageModel, retries: 1 })).embeddings[0],
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
  };
}
