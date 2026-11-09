import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { EngineCtx } from "../ctx";
import { ConfigMissing } from "../ports/config";
import { personaCards } from "../db/schema";
import type { EngineCfg } from "../config/load";
import type { Lease } from "../conversation/lease";
import type { PendingEvent } from "../conversation/events";
import { CostLedger } from "./cost";
import type { WaitStats, InboundState } from "./debounce";
import type { loadInbound } from "./inbound";
import type { TurnRecord } from "./plan";
import type { ChatMessage, jevLines } from "../drafting/thread";
import type { Facts, JevIn } from "../types";

/** The persona card the turn speaks for. */
export type Card = typeof personaCards.$inferSelect;

/**
 * Everything the stages of one turn share: the engine context, the lease, the config, the accumulator that survives a
 * later failure, the cost ledger, the clock the turn started on and the counters the pass loop keeps.
 */
export interface TurnState {
  ctx: EngineCtx;
  lease: Lease;
  cfg: EngineCfg;
  card: Card;
  /** Written as the turn goes, so a failure on a later attempt keeps what the earlier ones did. */
  acc: TurnRecord;
  startedAt: number;
  stats: WaitStats;
  foldIns: number;
  stillTypingReasks: number;
  /** What each reply attempt and filler returned; it becomes the accumulator's `jevOut`. */
  trail: unknown[];
  /** The fan messages and events the last load saw. */
  rows: Awaited<ReturnType<typeof loadInbound>>;
  pending: PendingEvent[];
  /** A wait or a fold-in starts only while the turn is young enough to finish inside the lease and the sweep. */
  budgetOk(): boolean;
  addCost(...args: Parameters<CostLedger["add"]>): void;
}

/** What Jev reads: the new messages and a little earlier context. */
export type JevState = { earlier_messages: ReturnType<typeof jevLines>; new_messages: string[] };

/** One settled read of the chat, before it is classified. */
export interface Batch {
  state: InboundState;
  history: ChatMessage[];
  facts: Facts;
  inboundIds: Set<string>;
  batchText: string;
  sessionGap: number | null;
  jevState: JevState;
  openOffer: string | null;
  /** The tips and unlocks the reply reacts to. */
  reacting: PendingEvent[];
  /** Nothing he wrote, only a tip or an unlock. */
  eventOnly: boolean;
}

/** Jev's read of a batch: the parsed answers and the raw ones. */
export interface Classified {
  jevIn: JevIn;
  jevAnswers: Record<string, string>;
}

/** Loads the published persona card and opens the accumulator fields the turn owns. */
export async function openTurnState(ctx: EngineCtx, lease: Lease, cfg: EngineCfg, acc: TurnRecord): Promise<TurnState> {
  const cost = new CostLedger();
  acc.tokens = cost.tokens;
  acc.models = { jev: cfg.jevModel, generate: cfg.generateModel, memory: cfg.memoryModel };

  const [card] = await ctx.db
    .select()
    .from(personaCards)
    // Only a published card speaks for the creator; a newly loaded version waits until it is published.
    .where(and(eq(personaCards.creatorId, lease.creatorId), isNotNull(personaCards.publishedAt)))
    .orderBy(desc(personaCards.version))
    .limit(1);
  if (!card) throw new ConfigMissing("persona_card");
  acc.personaVersion = card.version;

  const trail: unknown[] = [];
  acc.jevOut = trail;
  const { clock } = ctx.deps;
  const startedAt = clock.now();
  return {
    ctx,
    lease,
    cfg,
    card,
    acc,
    startedAt,
    stats: { waitedMs: 0, passes: 0 },
    foldIns: 0,
    stillTypingReasks: 0,
    trail,
    rows: [],
    pending: [],
    budgetOk: () => clock.now() - startedAt < cfg.turnBudgetMs,
    addCost: (...args) => {
      cost.add(...args);
      acc.costMicros = cost.costMicros;
    },
  };
}
