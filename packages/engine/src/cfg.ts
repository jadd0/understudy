import type { EngineCtx } from "./ctx";
import { ConfigMissing, type ConfigRow } from "./ports/config";
import { SAFETY_KEYS, type RouteCfg } from "./types";
import type { Prices } from "./cost";
import type { HandoffSla } from "./handoff";

export interface EngineCfg {
  jevModel: string;
  generateModel: string;
  memoryModel: string;
  debounceMs: number;
  debounceMaxMs: number;
  turnBudgetMs: number;
  gapMarkerMinutes: number;
  foldInMax: number;
  leaseMs: number;
  genAttempts: number;
  historyRounds: number;
  jevContextRounds: number;
  maxTokens: number;
  typingCps: number;
  typingMaxMs: number;
  bubbleGapMsMin: number;
  bubbleGapMsMax: number;
  retrievalK: number;
  offerTtlMinutes: number;
  eventWindowMinutes: number;
  offerHistoryCount: number;
  declineWindowMinutes: number;
  velocityWindowMinutes: number;
  hardshipCooldownHours: number;
  supportEmail: string;
  sla: HandoffSla;
  route: RouteCfg;
  prices: Record<string, Prices>;
}

const KEYS = [
  "jev.model",
  "model.generate",
  "model.memory",
  "engine.debounce_ms",
  "engine.debounce_max_ms",
  "engine.turn_budget_ms",
  "engine.gap_marker_minutes",
  "engine.fold_in_max",
  "engine.lease_ms",
  "engine.gen_attempts",
  "engine.history_rounds",
  "engine.jev_context_rounds",
  "engine.max_tokens",
  "engine.typing_cps",
  "engine.typing_max_ms",
  "delivery.bubble_gap_ms_min",
  "delivery.bubble_gap_ms_max",
  "retrieval.k",
  "offer.ttl_minutes",
  "engine.event_window_minutes",
  "engine.offer_history_count",
  "platform.support_email",
  "escalation.creator_sla_minutes",
  "escalation.ts_sla_minutes",
  "floor.intent",
  "floor.buy_intent_runner_up",
  ...SAFETY_KEYS.map((k) => `floor.safety.${k}`),
  "pitch.min_gap_rounds",
  "pitch.fit_floor",
  "pitch.decline_window_minutes",
  "pitch.max_declines",
  "pitch.hardship_cooldown_hours",
  "pitch.velocity_max_unlocks",
  "pitch.velocity_window_minutes",
];

/** Read when present: the models a failover may serve from. */
const OPTIONAL_KEYS = ["model.generate_fallback", "model.decide_fallback"];

/** A creator can tune voice and pacing but never loosen safety: these keys are read from platform rows only. */
export function isPlatformOnly(key: string): boolean {
  return key.startsWith("floor.") || key.startsWith("platform.");
}

const PRICE_PREFIX = "price.";

/**
 * The creator's row wins over the platform's, except for the platform-only keys, which are read from platform rows
 * alone. Rows the port returned for another creator or for keys nobody asked for are ignored.
 */
function resolve(rows: ConfigRow[], creatorId: string | undefined, wanted: (key: string) => boolean): Map<string, unknown> {
  const map = new Map<string, unknown>();
  const relevant = rows.filter((r) => wanted(r.key));
  for (const r of relevant.filter((r) => r.creatorId === null)) map.set(r.key, r.value);
  for (const r of relevant.filter((r) => r.creatorId !== null && r.creatorId === creatorId && !isPlatformOnly(r.key))) map.set(r.key, r.value);
  return map;
}

/** One setting: a creator's row wins, then the platform row. No code default: a missing row throws `ConfigMissing`. */
export async function getConfig<T = unknown>(ctx: Pick<EngineCtx, "config">, key: string, creatorId?: string): Promise<T> {
  const rows = await ctx.config.rows({ keys: [key], prefixes: [], creatorId });
  const map = resolve(rows, creatorId, (k) => k === key);
  if (!map.has(key)) throw new ConfigMissing(key);
  return map.get(key) as T;
}

/**
 * Every engine setting in one query: the creator's row wins over the platform's (except for the platform-only
 * keys), and a missing row throws `ConfigMissing`.
 */
export async function loadEngineConfig(ctx: Pick<EngineCtx, "config">, creatorId: string): Promise<EngineCfg> {
  const rows = await ctx.config.rows({ keys: [...KEYS, ...OPTIONAL_KEYS], prefixes: [PRICE_PREFIX], creatorId });
  const keySet = new Set([...KEYS, ...OPTIONAL_KEYS]);
  const map = resolve(rows, creatorId, (k) => keySet.has(k) || k.startsWith(PRICE_PREFIX));
  const get = <T>(key: string): T => {
    if (!map.has(key)) throw new ConfigMissing(key);
    return map.get(key) as T;
  };

  const jevModel = get<string>("jev.model");
  const generateModel = get<string>("model.generate");
  const memoryModel = get<string>("model.memory");
  const prices: Record<string, Prices> = {};
  const priceRow = (model: string, cached: boolean): Prices => ({
    input: get<number>(`price.${model}.input_per_mtok`),
    output: get<number>(`price.${model}.output_per_mtok`),
    cacheRead: cached ? get<number>(`price.${model}.cache_read_per_mtok`) : 0,
    cacheWrite: cached ? get<number>(`price.${model}.cache_write_per_mtok`) : 0,
  });
  for (const [model, cached] of [[jevModel, false], [generateModel, true], [memoryModel, true]] as const) prices[model] = priceRow(model, cached);
  // A failover can serve a turn from a fallback model, so its rows are loaded too. A fallback with no price rows is
  // left out and the turn fails closed if that model ever serves.
  for (const [key, cached] of [["model.generate_fallback", true], ["model.decide_fallback", false]] as const) {
    const model = map.get(key);
    if (typeof model !== "string" || prices[model]) continue;
    const complete = [`price.${model}.input_per_mtok`, `price.${model}.output_per_mtok`, ...(cached ? [`price.${model}.cache_read_per_mtok`, `price.${model}.cache_write_per_mtok`] : [])].every((k) => map.has(k));
    if (complete) prices[model] = priceRow(model, cached);
  }
  const floors = { intent: get<number>("floor.intent"), buyIntentRunnerUp: get<number>("floor.buy_intent_runner_up") } as RouteCfg["floors"];
  for (const k of SAFETY_KEYS) floors[k] = get<number>(`floor.safety.${k}`);

  return {
    jevModel,
    generateModel,
    memoryModel,
    debounceMs: get("engine.debounce_ms"),
    debounceMaxMs: get("engine.debounce_max_ms"),
    turnBudgetMs: get("engine.turn_budget_ms"),
    gapMarkerMinutes: get("engine.gap_marker_minutes"),
    foldInMax: get("engine.fold_in_max"),
    leaseMs: get("engine.lease_ms"),
    genAttempts: get("engine.gen_attempts"),
    historyRounds: get("engine.history_rounds"),
    jevContextRounds: get("engine.jev_context_rounds"),
    maxTokens: get("engine.max_tokens"),
    typingCps: get("engine.typing_cps"),
    typingMaxMs: get("engine.typing_max_ms"),
    bubbleGapMsMin: get("delivery.bubble_gap_ms_min"),
    bubbleGapMsMax: get("delivery.bubble_gap_ms_max"),
    retrievalK: get("retrieval.k"),
    offerTtlMinutes: get("offer.ttl_minutes"),
    eventWindowMinutes: get("engine.event_window_minutes"),
    offerHistoryCount: get("engine.offer_history_count"),
    declineWindowMinutes: get("pitch.decline_window_minutes"),
    velocityWindowMinutes: get("pitch.velocity_window_minutes"),
    hardshipCooldownHours: get("pitch.hardship_cooldown_hours"),
    supportEmail: get("platform.support_email"),
    sla: { creatorMinutes: get("escalation.creator_sla_minutes"), tsMinutes: get("escalation.ts_sla_minutes") },
    route: {
      floors,
      minGapRounds: get("pitch.min_gap_rounds"),
      fitFloor: get("pitch.fit_floor"),
      maxDeclines: get("pitch.max_declines"),
      velocityMaxUnlocks: get("pitch.velocity_max_unlocks"),
    },
    prices,
  };
}

/** The two handoff due times, read on their own so a turn that fails before its full config loads can still open a handoff. */
export async function loadSla(ctx: Pick<EngineCtx, "config">, creatorId: string): Promise<HandoffSla> {
  const [creatorMinutes, tsMinutes] = await Promise.all([
    getConfig<number>(ctx, "escalation.creator_sla_minutes", creatorId),
    getConfig<number>(ctx, "escalation.ts_sla_minutes", creatorId),
  ]);
  return { creatorMinutes, tsMinutes };
}
