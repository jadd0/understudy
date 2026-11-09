// The engine's view of the app it runs inside. Everything the engine needs from tables it does not own (the wallet,
// the ledger, the catalogue, unlocks, users) comes through this one injected port. This file imports nothing from the app.

export type ShortlistKind = "ppv" | "bundle" | "personal";

export interface ShortlistItem {
  id: string;
  kind: ShortlistKind;
  title: string;
  teaser: string | null;
  priceCents: number;
  /** He has already unlocked it: offered only when nothing he does not own is left, and unlocking it again is charged. */
  owned?: boolean;
}

/** What the host knows about a fan that routing and pacing read. */
export interface HostFanFacts {
  /** Cents spent since 00:00 UTC today, and the cap in force (his own, matured raise included, else the platform's). */
  spentTodayCents: number;
  capCents: number;
  /** Nothing more fits under the cap today: the cap refuses even one cent. */
  atCap: boolean;
  /** Unlock ledger entries inside the velocity window. */
  unlocksInWindow: number;
  highValue: boolean;
}

export interface ShortlistQuery {
  creatorId: string;
  fanId: string;
  conversationId: string;
  kinds?: ShortlistKind[];
}

export interface HostItem {
  title: string;
  priceCents: number;
  kind: ShortlistKind;
}

/** A transaction the engine holds. Typed by the one method the host may use, so this file needs no database import. */
export interface HostTx {
  execute(query: never): Promise<unknown>;
}

export type FlagReason = string;

export interface HostPort {
  fanFacts(q: { fanId: string; creatorId: string; velocityWindowMinutes: number }): Promise<HostFanFacts>;
  /** The wallet's cap rule: whether `priceCents` fits under `capCents` after `spentCents`. */
  capAllows(spentCents: number, priceCents: number, capCents: number): boolean;
  catalogue: {
    /** The creator's active items the fan does not own and that are not the subject of an open offer here. */
    shortlist(q: ShortlistQuery): Promise<ShortlistItem[]>;
    /** Same kinds and order, but items he already owns (unlocking one again is charged). */
    ownedShortlist(q: ShortlistQuery): Promise<ShortlistItem[]>;
    /** Whether he owns every active ppv and bundle item the creator lists (and at least one). */
    ownsEverything(creatorId: string, fanId: string): Promise<boolean>;
  };
  items(ids: string[]): Promise<Map<string, HostItem>>;
  owns(fanId: string, itemIds: string[]): Promise<Set<string>>;
  /** Account-level flag, written inside the engine's transaction after it holds the conversation lock. */
  flagFan(tx: HostTx, fanId: string, reason: FlagReason): Promise<void>;
}
