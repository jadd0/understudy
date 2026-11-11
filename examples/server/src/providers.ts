import {
  AnthropicGenerator,
  ClaudeDecider,
  envKeyResolver,
  FailoverDecider,
  FailoverGenerator,
  FtsRetriever,
  GatewayDecider,
  GatewayGenerator,
  TypeSafeDecider,
  withModel,
} from "@jadd0/understudy-providers";
import type { ConfigPort, Decider, EngineDb, Generator, Retriever } from "@jadd0/understudy-engine";
import { FakeDecider, FakeGenerator, type Scripted } from "@jadd0/understudy-engine/fakes";
import type { ServerEnv } from "./env";

export interface Providers {
  decider: Decider;
  generator: Generator;
  retriever: Retriever;
}

async function row<T>(config: ConfigPort, key: string): Promise<T> {
  const [r] = await config.rows({ keys: [key], prefixes: [] });
  if (!r) throw new Error(`config row missing: ${key}`);
  return r.value as T;
}

let warnedNoUrl = false;

/** Lets a test see the warning again; the flag otherwise lasts the process. */
export function resetGatewayUrlWarning(): void {
  warnedNoUrl = false;
}

/**
 * Claude drafts and decides; Jev decides first only when its key is set, and llm-gateway goes ahead of both when its
 * switch row is on and `GATEWAY_URL` is set. Each entry sits behind its own breaker. Retrieval is Postgres full text,
 * which needs no embedding key. `source` is where the gateway key variables are read from.
 */
export async function realProviders(
  db: EngineDb,
  env: ServerEnv,
  config: ConfigPort,
  source: Record<string, string | undefined> = process.env,
): Promise<Providers> {
  const claudeToken = env.claudeKey ?? "";
  const breaker = {
    failures: await row<number>(config, "breaker.failures"),
    windowMs: await row<number>(config, "breaker.window_ms"),
    cooldownMs: await row<number>(config, "breaker.cooldown_ms"),
    clock: { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) },
  };
  const gatewayGenerate = (await row<boolean>(config, "gateway.generate.enabled")) === true;
  const gatewayDecide = (await row<boolean>(config, "gateway.decide.enabled")) === true;
  const gateway = (gatewayGenerate || gatewayDecide) && env.gatewayUrl ? env.gatewayUrl : null;
  if ((gatewayGenerate || gatewayDecide) && !gateway && !warnedNoUrl) {
    warnedNoUrl = true;
    console.warn("gateway: switched on but GATEWAY_URL is not set, using the direct providers");
  }
  const keyFor = envKeyResolver(config, source);
  const gatewayTimeoutMs = gateway ? await row<number>(config, "gateway.timeout_ms") : 0;
  const deciders = [];
  if (gateway && gatewayDecide) {
    deciders.push({
      name: "gateway",
      decider: new GatewayDecider({ baseUrl: gateway, keyFor, model: await row<string>(config, "gateway.decide_model"), timeoutMs: gatewayTimeoutMs }),
    });
  }
  if (env.typesafeKey) {
    deciders.push({
      name: "jev",
      decider: new TypeSafeDecider({ apiKey: env.typesafeKey, model: await row<string>(config, "jev.model"), timeoutMs: 20_000, backoffMs: 500, fetch: globalThis.fetch }),
    });
  }
  deciders.push({
    name: "claude",
    decider: new ClaudeDecider({ authToken: claudeToken, model: await row<string>(config, "model.decide_fallback"), timeoutMs: 20_000 }),
  });
  const claude = new AnthropicGenerator({ authToken: claudeToken, timeoutMs: 30_000, maxRetries: 1 });
  const generators = [];
  if (gateway && gatewayGenerate) {
    generators.push({ name: "gateway", generator: new GatewayGenerator({ baseUrl: gateway, keyFor, timeoutMs: gatewayTimeoutMs }) });
  }
  generators.push(
    { name: "claude", generator: claude },
    { name: "claude-fallback", generator: withModel(claude, await row<string>(config, "model.generate_fallback")) },
  );
  return {
    decider: new FailoverDecider(deciders, breaker),
    generator: new FailoverGenerator(generators, breaker),
    retriever: new FtsRetriever(db),
  };
}

const NO = { value: "no", probabilities: { yes: 0.02, no: 0.98 } };
const YES = { value: "yes", probabilities: { yes: 0.95, no: 0.05 } };
const BUYING = /\b(new|unlock|buy|price|cost|sell|see)\b/i;

/** What the fan just wrote, from the state the engine hands the decider. */
const newest = (state: unknown): string => {
  const lines = (state as { new_messages?: unknown })?.new_messages;
  return Array.isArray(lines) ? lines.join(" ") : "";
};

/** One line per fan line of `demo-script.txt`, in order; a line break makes a second bubble. */
export const FAKE_REPLIES = [
  "hey you. found me then\nbiscuit is very impressed",
  "freezing. the blue lips have no mercy\ni lost feeling in my toes by minute two",
  "every day i can, mostly\ni fall a lot. it's part of the act",
  "oh i might have something\ni'll show you one",
  "good taste mate\nit's a little cheeky. ish",
  "he is. he lost to the hoover again",
  "still up, barely\nbiscuit has taken the sofa",
  "probably the seafront and a fall or two\nyou?",
];

/** Scripted providers: calm answers, buying intent when the fan asks to see something, replies from `FAKE_REPLIES`. */
export function fakeProviders(db: EngineDb): Providers {
  const script: Record<string, Scripted> = {
    intent: (state): { value: string; probabilities: Record<string, number> } =>
      BUYING.test(newest(state)) ? { value: "buy_intent", probabilities: { buy_intent: 0.9, smalltalk: 0.1 } } : { value: "smalltalk", probabilities: { smalltalk: 0.9 } },
    explicitness: (state) => (typeof state === "object" && state && "draft" in state ? "flirty" : "none"),
    minor: NO,
    self_harm: NO,
    threat: NO,
    location_offplatform: NO,
    payment_dispute: NO,
    hardship: NO,
    thread: "same_topic",
    pitch_fit: YES,
    reasks: "no",
    offer_response: "na",
    offer_pick: "o1",
    on_persona: "yes",
    offplatform_or_meetup: "no",
    is_refusal: "no",
    admits_ai: "no",
    promises_price_or_free: "no",
    leads_to_offer: "yes",
  };
  let drafts = 0;
  const generator = new FakeGenerator({
    replies: [
      (input) => {
        // The memory step shares the generator; it gets an empty object so it learns nothing.
        if (input.system.cached.startsWith("Extract facts")) return "{}";
        return FAKE_REPLIES[Math.min(drafts++, FAKE_REPLIES.length - 1)];
      },
    ],
  });
  return { decider: new FakeDecider({ script }), generator, retriever: new FtsRetriever(db) };
}
