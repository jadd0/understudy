// An in-memory HostPort for the engine's pure tests. Not imported by product code.
import type { FlagReason, HostFanFacts, HostItem, HostPort, HostTx, ShortlistItem, ShortlistQuery } from "../ports/host.js";

export interface FakeHostOptions {
  facts?: Partial<HostFanFacts>;
  /** The creator's active catalogue, in the order the real shortlist returns it (price, title, id). */
  items?: ShortlistItem[];
  /** Item ids the fan owns. */
  owned?: Iterable<string>;
}

const DEFAULT_FACTS: HostFanFacts = { spentTodayCents: 0, capCents: 20_000, atCap: false, unlocksInWindow: 0, highValue: false };

export class FakeHost implements HostPort {
  facts: HostFanFacts;
  items_: ShortlistItem[];
  owned: Set<string>;
  flagged: { fanId: string; reason: FlagReason }[] = [];

  constructor(opts: FakeHostOptions = {}) {
    this.facts = { ...DEFAULT_FACTS, ...opts.facts };
    this.items_ = opts.items ?? [];
    this.owned = new Set(opts.owned ?? []);
  }

  async fanFacts(): Promise<HostFanFacts> {
    return this.facts;
  }

  capAllows(spentCents: number, priceCents: number, capCents: number): boolean {
    return spentCents + priceCents <= capCents;
  }

  private pick(q: ShortlistQuery, owned: boolean): ShortlistItem[] {
    return this.items_
      .filter((i) => this.owned.has(i.id) === owned && (!q.kinds || q.kinds.length === 0 || q.kinds.includes(i.kind)))
      .map((i) => (owned ? { ...i, owned: true } : i));
  }

  catalogue = {
    shortlist: async (q: ShortlistQuery) => this.pick(q, false),
    ownedShortlist: async (q: ShortlistQuery) => this.pick(q, true),
    ownsEverything: async (_creatorId?: string, _fanId?: string) => {
      const sellable = this.items_.filter((i) => i.kind === "ppv" || i.kind === "bundle");
      return sellable.length > 0 && sellable.every((i) => this.owned.has(i.id));
    },
  };

  async items(ids: string[]): Promise<Map<string, HostItem>> {
    return new Map(this.items_.filter((i) => ids.includes(i.id)).map((i) => [i.id, { title: i.title, priceCents: i.priceCents, kind: i.kind }]));
  }

  async owns(_fanId: string, itemIds: string[]): Promise<Set<string>> {
    return new Set(itemIds.filter((id) => this.owned.has(id)));
  }

  async flagFan(_tx: HostTx, fanId: string, reason: FlagReason): Promise<void> {
    this.flagged.push({ fanId, reason });
  }
}
