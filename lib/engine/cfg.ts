import { and, eq, inArray, isNull, like, or } from "drizzle-orm";
import { db } from "@/db/client";
import { config } from "@/db/schema";
import { ConfigMissing } from "@/lib/config";
import { SAFETY_KEYS, type RouteCfg } from "./types";
import type { Prices } from "./cost";

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

/** A creator can tune voice and pacing but never loosen safety: these keys are read from platform rows only. */
export function isPlatformOnly(key: string): boolean {
  return key.startsWith("floor.") || key.startsWith("platform.");
}

/**
 * Every engine setting in one query: the creator's row wins over the platform's (except for the platform-only
 * keys), and a missing row throws `ConfigMissing`.
 */
export async function loadEngineConfig(creatorId: string): Promise<EngineCfg> {
  const rows = await db
    .select({ key: config.key, value: config.value, creatorId: config.creatorId })
    .from(config)
    .where(
      and(
        or(inArray(config.key, KEYS), like(config.key, "price.%")),
        or(isNull(config.creatorId), eq(config.creatorId, creatorId)),
      ),
    );
  const map = new Map<string, unknown>();
  for (const r of rows.filter((r) => r.creatorId === null)) map.set(r.key, r.value);
  for (const r of rows.filter((r) => r.creatorId !== null && !isPlatformOnly(r.key))) map.set(r.key, r.value);
  const get = <T>(key: string): T => {
    if (!map.has(key)) throw new ConfigMissing(key);
    return map.get(key) as T;
  };

  const jevModel = get<string>("jev.model");
  const generateModel = get<string>("model.generate");
  const memoryModel = get<string>("model.memory");
  const prices: Record<string, Prices> = {};
  for (const [model, cached] of [[jevModel, false], [generateModel, true], [memoryModel, true]] as const) {
    prices[model] = {
      input: get<number>(`price.${model}.input_per_mtok`),
      output: get<number>(`price.${model}.output_per_mtok`),
      cacheRead: cached ? get<number>(`price.${model}.cache_read_per_mtok`) : 0,
      cacheWrite: cached ? get<number>(`price.${model}.cache_write_per_mtok`) : 0,
    };
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
