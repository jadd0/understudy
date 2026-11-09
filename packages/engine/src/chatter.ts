import { and, eq } from "drizzle-orm";
import type { EngineCtx, Deps } from "./ctx";
import { loadFacts, type FactsCfg, type LoadedFacts } from "./facts";
import type { HostPort } from "./host";
import { creatorAi, setCreatorAi } from "./creator-settings";
import { handBack, supersedeUnseenBubbles } from "./lease";
import { migrateEngine } from "./migrate";
import { expireOffers } from "./offer";
import type { ConfigPort } from "./ports/config";
import type { EngineDb, EngineTx } from "./ports/db";
import { processConversation } from "./process";
import { conversations, messages } from "./schema";
import { sweep, type SweepResult } from "./sweep";
import { runTurn, type TurnResult } from "./turn";

export const MAX_MESSAGE_CHARS = 2000;

export const MAX_CLIENT_MSG_ID_CHARS = 100;

/** Why `handleMessage` stored nothing. `not_owner`: the client message id already belongs to another fan. */
export const MESSAGE_REFUSED_CODES = ["empty", "too_long", "bad_id", "not_owner"] as const;
export type MessageRefusedCode = (typeof MESSAGE_REFUSED_CODES)[number];

export class MessageRefused extends Error {
  constructor(public readonly code: MessageRefusedCode) {
    super(`message refused: ${code}`);
    this.name = "MessageRefused";
  }
}

export interface IncomingMessage {
  creatorId: string;
  /** The sender. It must come from the host's session, never from client input. */
  fanId: string;
  body: string;
  /** The client's idempotency key for this message. */
  clientMsgId: string;
}

export interface HandledMessage {
  conversationId: string;
  messageId: string;
  /** True when this client message id was already saved; nothing new was stored and `process` does nothing. */
  duplicate: boolean;
  /** Answers the conversation. The host decides when to run it (after the response, inline, from a queue). */
  process: () => Promise<void>;
}

export interface Chatter {
  /** Creates or updates the engine's tables. Run it before the host's own migrations, which point at them. */
  migrate(): Promise<void>;
  /** Switches the AI on or off for every conversation of one creator. */
  setCreatorAi(creatorId: string, on: boolean): Promise<void>;
  /** Whether the creator's AI is on; a creator never switched is on. */
  creatorAi(creatorId: string): Promise<boolean>;
  /**
   * Stores a fan's message and returns the step that answers it. Who may send (role, age, flags, whether the
   * creator exists) is the host's check, made before this call. The message is stored even when a human owns the
   * conversation; the engine's lease refuses to answer it then. Re-sending a client message id returns the saved one.
   */
  handleMessage(m: IncomingMessage): Promise<HandledMessage>;
  /** Answers a conversation until nothing unanswered is left; returns how many turns committed. */
  processConversation(conversationId: string): Promise<number>;
  /** One turn, for hosts that drive turns one at a time. */
  runTurn(conversationId: string): Promise<TurnResult>;
  /** The safety net behind the per-send trigger: clears expired leases, answers stragglers, expires offers. */
  sweep(): Promise<SweepResult>;
  /** Gives a conversation back to the AI; messages a human already handled stay unanswered. */
  handBack(conversationId: string, opts?: { allWaiting?: boolean }): Promise<void>;
  /** Supersedes AI bubbles the fan has not seen yet, inside the caller's transaction. */
  supersedeUnseenBubbles(tx: EngineTx, conversationId: string): Promise<void>;
  /** Marks open offers past their expiry; returns how many. */
  expireOffers(): Promise<number>;
  /** What routing and pacing read about one conversation. */
  loadFacts(conversationId: string, fanId: string, creatorId: string, cfg: FactsCfg): Promise<LoadedFacts>;
}

export interface ChatterOptions {
  /** A drizzle client over the Neon WebSocket pool. The host's own transactions and the engine's share it. */
  db: EngineDb;
  /** Reads the `config` rows. The engine fails closed on a missing row. */
  config: ConfigPort;
  /** The host's tables: wallet, catalogue, unlocks, users. */
  host: HostPort;
  /** The providers: decider, generator, retriever, events, clock. */
  deps: Deps;
}

/** Builds the engine over the database, settings, host and providers it is handed. Nothing is read from the environment. */
export function createChatter(opts: ChatterOptions): Chatter {
  const ctx: EngineCtx = { db: opts.db, config: opts.config, host: opts.host, deps: opts.deps };
  return {
    migrate: () => migrateEngine(ctx.db),
    setCreatorAi: (creatorId, on) => setCreatorAi(ctx.db, creatorId, on),
    creatorAi: (creatorId) => creatorAi(ctx.db, creatorId),
    handleMessage: (m) => handleMessage(ctx, m),
    processConversation: (id) => processConversation(ctx, id),
    runTurn: (id) => runTurn(ctx, id),
    sweep: () => sweep(ctx),
    handBack: (id, o) => handBack(ctx, id, o),
    supersedeUnseenBubbles,
    expireOffers: () => expireOffers(ctx),
    loadFacts: (conversationId, fanId, creatorId, cfg) => loadFacts(ctx, conversationId, fanId, creatorId, cfg),
  };
}

async function handleMessage(ctx: EngineCtx, m: IncomingMessage): Promise<HandledMessage> {
  const { db } = ctx;
  const { creatorId, fanId, clientMsgId } = m;
  const text = m.body.trim();
  if (text.length === 0) throw new MessageRefused("empty");
  if (text.length > MAX_MESSAGE_CHARS) throw new MessageRefused("too_long");
  if (typeof clientMsgId !== "string" || clientMsgId.length === 0 || clientMsgId.length > MAX_CLIENT_MSG_ID_CHARS) {
    throw new MessageRefused("bad_id");
  }
  const noop = async () => {};
  const saved = (conversationId: string, messageId: string): HandledMessage => ({ conversationId, messageId, duplicate: true, process: noop });

  // A client message id belongs to whoever first used it. Checked before the conversation is created, so a
  // refused send leaves no row behind.
  const [taken] = await db
    .select({ id: messages.id, conversationId: messages.conversationId, senderUserId: messages.senderUserId })
    .from(messages)
    .where(eq(messages.clientMsgId, clientMsgId));
  if (taken) {
    if (taken.senderUserId !== fanId) throw new MessageRefused("not_owner");
    return saved(taken.conversationId, taken.id);
  }

  await db.insert(conversations).values({ creatorId, fanId }).onConflictDoNothing();
  const [conv] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.creatorId, creatorId), eq(conversations.fanId, fanId)));

  const [inserted] = await db
    .insert(messages)
    .values({ conversationId: conv.id, sender: "fan", senderUserId: fanId, body: text, clientMsgId })
    .onConflictDoNothing({ target: messages.clientMsgId })
    .returning({ id: messages.id });
  if (!inserted) {
    const [existing] = await db
      .select({ id: messages.id, conversationId: messages.conversationId, senderUserId: messages.senderUserId })
      .from(messages)
      .where(eq(messages.clientMsgId, clientMsgId));
    if (!existing || existing.senderUserId !== fanId) throw new MessageRefused("not_owner");
    return saved(existing.conversationId, existing.id);
  }

  // He has stopped typing: the engine must not keep holding his turn for a ping that is still in the future.
  await db.update(conversations).set({ fanTypingUntil: null }).where(eq(conversations.id, conv.id));

  return {
    conversationId: conv.id,
    messageId: inserted.id,
    duplicate: false,
    process: async () => {
      await processConversation(ctx, conv.id);
    },
  };
}
