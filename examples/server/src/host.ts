import { readFileSync } from "node:fs";
import { and, eq, gt } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { EngineDb, EngineTx, HostPort, ShortlistKind } from "@understudy/engine";
import { offers } from "@understudy/engine/schema";

export interface CatalogueItem {
  id: string;
  creatorId: string;
  kind: ShortlistKind;
  title: string;
  teaser: string | null;
  priceCents: number;
}

export function readCatalogue(file: string): CatalogueItem[] {
  return (JSON.parse(readFileSync(file, "utf8")) as { items: CatalogueItem[] }).items;
}

type Facts = Awaited<ReturnType<HostPort["fanFacts"]>>;
type Item = Awaited<ReturnType<HostPort["items"]>> extends Map<string, infer V> ? V : never;

/**
 * The host the headless server gives the engine. There is no wallet: nothing is spent, owned or unlocked, so the
 * daily cap is a fixed number and a fan is never high value. Settlement of an offer is the calling product's job.
 */
export class ServerHost implements HostPort {
  constructor(
    private readonly db: EngineDb,
    private readonly items_: readonly CatalogueItem[],
    private readonly capCents: number,
  ) {}

  async fanFacts(): Promise<Facts> {
    return { spentTodayCents: 0, capCents: this.capCents, atCap: !this.capAllows(0, 1, this.capCents), unlocksInWindow: 0, highValue: false };
  }

  /** The wallet's cap rule: what is spent plus the price fits under the cap. */
  capAllows(spentCents: number, priceCents: number, capCents: number): boolean {
    return spentCents + priceCents <= capCents;
  }

  catalogue: HostPort["catalogue"] = {
    shortlist: async (q) => {
      const open = await this.db
        .select({ itemId: offers.itemId })
        .from(offers)
        .where(and(eq(offers.conversationId, q.conversationId), eq(offers.status, "open"), gt(offers.expiresAt, sql`now()`)));
      const taken = new Set(open.map((o) => o.itemId));
      return this.items_
        .filter((i) => i.creatorId === q.creatorId && !taken.has(i.id) && (!q.kinds || q.kinds.length === 0 || q.kinds.includes(i.kind)))
        .sort((a, b) => a.priceCents - b.priceCents || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
        .map((i) => ({ id: i.id, kind: i.kind, title: i.title, teaser: i.teaser, priceCents: i.priceCents }));
    },
    ownedShortlist: async () => [],
    ownsEverything: async () => false,
  };

  async items(ids: string[]): Promise<Map<string, Item>> {
    return new Map(this.items_.filter((i) => ids.includes(i.id)).map((i) => [i.id, { title: i.title, priceCents: i.priceCents, kind: i.kind }]));
  }

  async owns(): Promise<Set<string>> {
    return new Set();
  }

  /** Records the flag in the server's own table, inside the engine's transaction. The first reason stays. */
  async flagFan(tx: Parameters<HostPort["flagFan"]>[0], fanId: string, reason: string): Promise<void> {
    await (tx as unknown as EngineTx).execute(sql`insert into server_flags (fan_id, reason) values (${fanId}, ${reason}) on conflict (fan_id) do nothing`);
  }
}

/** The server's one table of its own. Created at start, one statement. */
export const CREATE_FLAGS_TABLE = `create table if not exists server_flags (fan_id uuid primary key, reason text not null, flagged_at timestamptz not null default now())`;

/** What the routes read that the engine does not expose: whether a fan is flagged, a conversation's mode. */
export interface ServerStore {
  isFlagged(fanId: string): Promise<boolean>;
  modeOf(conversationId: string): Promise<string | null>;
}

export function serverStore(db: EngineDb): ServerStore {
  return {
    async isFlagged(fanId) {
      const { rows } = await db.execute(sql`select 1 from server_flags where fan_id = ${fanId}`);
      return rows.length > 0;
    },
    async modeOf(conversationId) {
      const { rows } = await db.execute(sql`select mode from conversations where id = ${conversationId}`);
      return (rows[0] as { mode: string } | undefined)?.mode ?? null;
    },
  };
}
