import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/db/client";
import { users } from "@/db/schema";
import { getConfig } from "@/lib/config";
import { capAllows } from "@/lib/wallet/cap";
import { isHighValue } from "@/lib/wallet/score";
import type { HostPort, ShortlistKind, ShortlistQuery } from "@jadd0/understudy-engine";

const kindFilterOf = (kinds?: ShortlistKind[]) =>
  kinds && kinds.length > 0 ? sql`and c.kind in (${sql.join(kinds.map((k) => sql`${k}::catalogue_kind`), sql`, `)})` : sql``;

/** The database-backed host: the wallet, ledger, catalogue, unlocks and users the engine reads and flags through the port. */
export const dbHost: HostPort = {
  /**
   * Reads only: the engine never takes a wallet lock, so the cap is derived here (a matured raise counts)
   * rather than applied the way `effectiveCap` does under the wallet lock.
   */
  async fanFacts({ fanId, creatorId, velocityWindowMinutes }) {
    const platformCap = await getConfig<number>("wallet.daily_cap_cents");
    const highValue = await isHighValue(fanId, creatorId);
    const { rows } = await db.execute(sql`
      select
        (select count(*)::int from ledger_entries
          where fan_id = ${fanId} and kind = 'unlock'
            and created_at > now() - make_interval(mins => ${velocityWindowMinutes}::int)) as unlocks,
        (select coalesce(sum(-amount_cents), 0)::int from ledger_entries
          where fan_id = ${fanId} and amount_cents < 0
            and created_at >= (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')) as spent,
        (select case when pending_cap_cents is not null and pending_cap_at <= now() then pending_cap_cents
                     else daily_cap_cents end
           from wallets where fan_id = ${fanId}) as own_cap`);
    const r = rows[0] as { unlocks: number; spent: number; own_cap: number | null };
    const capCents = r.own_cap ?? platformCap;
    return {
      spentTodayCents: r.spent,
      capCents,
      atCap: !capAllows(r.spent, 1, capCents),
      unlocksInWindow: r.unlocks,
      highValue,
    };
  },

  capAllows,

  catalogue: {
    async shortlist({ creatorId, fanId, conversationId, kinds }: ShortlistQuery) {
      const kindFilter = kindFilterOf(kinds);
      const { rows } = await db.execute(sql`
        select c.id, c.kind, c.title, c.teaser, c.price_cents as "priceCents"
        from catalogue_items c
        where c.creator_id = ${creatorId} and c.active ${kindFilter}
          and not exists (select 1 from unlocks u where u.fan_id = ${fanId} and u.item_id = c.id)
          and not exists (select 1 from offers o
                          where o.conversation_id = ${conversationId} and o.item_id = c.id
                            and o.status = 'open' and o.expires_at > now())
        order by c.price_cents, c.title, c.id`);
      return rows as unknown as Awaited<ReturnType<HostPort["catalogue"]["shortlist"]>>;
    },

    async ownedShortlist({ creatorId, fanId, conversationId, kinds }: ShortlistQuery) {
      const kindFilter = kindFilterOf(kinds);
      const { rows } = await db.execute(sql`
        select c.id, c.kind, c.title, c.teaser, c.price_cents as "priceCents", true as owned
        from catalogue_items c
        where c.creator_id = ${creatorId} and c.active ${kindFilter}
          and exists (select 1 from unlocks u where u.fan_id = ${fanId} and u.item_id = c.id)
          and not exists (select 1 from offers o
                          where o.conversation_id = ${conversationId} and o.item_id = c.id
                            and o.status = 'open' and o.expires_at > now())
        order by c.price_cents, c.title, c.id`);
      return rows as unknown as Awaited<ReturnType<HostPort["catalogue"]["ownedShortlist"]>>;
    },

    async ownsEverything(creatorId, fanId) {
      const { rows } = await db.execute(sql`
        select count(*)::int as listed,
               count(*) filter (where exists (select 1 from unlocks u where u.fan_id = ${fanId} and u.item_id = c.id))::int as owned
        from catalogue_items c
        where c.creator_id = ${creatorId} and c.active and c.kind in ('ppv', 'bundle')`);
      const r = rows[0] as { listed: number; owned: number };
      return r.listed > 0 && r.owned === r.listed;
    },
  },

  async items(ids) {
    const out = new Map<string, { title: string; priceCents: number; kind: ShortlistKind }>();
    if (ids.length === 0) return out;
    const { rows } = await db.execute(sql`
      select id, title, price_cents as "priceCents", kind from catalogue_items
      where id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`);
    for (const r of rows as { id: string; title: string; priceCents: number; kind: ShortlistKind }[]) {
      out.set(r.id, { title: r.title, priceCents: r.priceCents, kind: r.kind });
    }
    return out;
  },

  async owns(fanId, itemIds) {
    if (itemIds.length === 0) return new Set();
    const { rows } = await db.execute(sql`
      select item_id from unlocks
      where fan_id = ${fanId} and item_id in (${sql.join(itemIds.map((i) => sql`${i}::uuid`), sql`, `)})`);
    return new Set((rows as { item_id: string }[]).map((r) => r.item_id));
  },

  /** `minor` is stored as `minor_in_chat`: restricted to reading, sessions kept. Flagged once (coalesce). */
  async flagFan(tx, fanId, reason) {
    const flagReason = reason === "minor" ? "minor_in_chat" : reason;
    await (tx as unknown as Tx)
      .update(users)
      .set({ flaggedAt: sql`coalesce(${users.flaggedAt}, now())`, flagReason: sql`coalesce(${users.flagReason}, ${flagReason})` })
      .where(eq(users.id, fanId));
  },
};
