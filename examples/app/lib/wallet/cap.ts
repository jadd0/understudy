import { eq, sql } from "drizzle-orm";
import { withTx, type Tx } from "@/db/client";
import { wallets } from "@/db/schema";
import { getConfig } from "@/lib/config";
import { CapReached, InvalidAmount } from "./errors";
import { lockWallet } from "./ledger";

/** Cents the fan has spent since 00:00 UTC today (unlocks and tips), by the database clock. */
export async function spentToday(tx: Tx, fanId: string): Promise<number> {
  const { rows } = await tx.execute(sql`
    select coalesce(sum(-amount_cents), 0)::int as spent
    from ledger_entries
    where fan_id = ${fanId}
      and amount_cents < 0
      and created_at >= (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')`);
  return Number((rows[0] as { spent: number }).spent);
}

export type FanCap = {
  effectiveCents: number;
  /** A raise still waiting out the cooling-off period. */
  pending: { cents: number; at: Date } | null;
};

/**
 * The cap in force for this fan: their own if set, else the platform default. A raise whose time has come is
 * applied here, lazily, so there is no job to run. The caller holds the wallet lock.
 */
export async function effectiveCap(tx: Tx, fanId: string, platformCapCents: number, now: Date): Promise<FanCap> {
  const [w] = await tx.select().from(wallets).where(eq(wallets.fanId, fanId));
  let own = w?.dailyCapCents ?? null;
  let pending = w?.pendingCapCents != null && w.pendingCapAt ? { cents: w.pendingCapCents, at: w.pendingCapAt } : null;
  if (pending && pending.at <= now) {
    await tx
      .update(wallets)
      .set({ dailyCapCents: pending.cents, pendingCapCents: null, pendingCapAt: null })
      .where(eq(wallets.fanId, fanId));
    own = pending.cents;
    pending = null;
  }
  return { effectiveCents: own ?? platformCapCents, pending };
}

/**
 * The one cap rule: a charge of `amountCents` fits when today's spend plus it stays within the cap. The debit
 * enforces it and the engine pitches only items it allows, so the AI never offers what the cap would refuse.
 */
export function capAllows(spentCents: number, amountCents: number, capCents: number): boolean {
  return spentCents + amountCents <= capCents;
}

/** Throws CapReached when today's spend plus this debit would pass the fan's effective cap. */
export async function assertWithinCap(
  tx: Tx,
  fanId: string,
  amountCents: number,
  platformCapCents: number,
  now: Date,
) {
  const { effectiveCents } = await effectiveCap(tx, fanId, platformCapCents, now);
  if (!capAllows(await spentToday(tx, fanId), amountCents, effectiveCents)) throw new CapReached();
}

/**
 * The fan sets their own daily cap. Lowering applies at once; raising waits `wallet.cap_raise_delay_hours`
 * (cooling off), so a fan in the moment cannot lift their own limit. Below `wallet.cap_min_cents` or above `cap.max_daily_cents` is refused.
 */
export async function setFanCap(fanId: string, cents: number, now: Date = new Date()): Promise<FanCap> {
  const [min, max, delayHours, platformCap] = await Promise.all([
    getConfig<number>("wallet.cap_min_cents"),
    getConfig<number>("cap.max_daily_cents"),
    getConfig<number>("wallet.cap_raise_delay_hours"),
    getConfig<number>("wallet.daily_cap_cents"),
  ]);
  if (!Number.isSafeInteger(cents) || cents < min || cents > max) throw new InvalidAmount();

  return withTx(async (tx) => {
    await lockWallet(tx, fanId);
    const current = await effectiveCap(tx, fanId, platformCap, now);
    if (cents <= current.effectiveCents) {
      await tx
        .update(wallets)
        .set({ dailyCapCents: cents, pendingCapCents: null, pendingCapAt: null })
        .where(eq(wallets.fanId, fanId));
      return { effectiveCents: cents, pending: null };
    }
    const at = new Date(now.getTime() + delayHours * 3_600_000);
    await tx.update(wallets).set({ pendingCapCents: cents, pendingCapAt: at }).where(eq(wallets.fanId, fanId));
    return { effectiveCents: current.effectiveCents, pending: { cents, at } };
  });
}

/** What the fan's cap is right now, applying a matured raise. */
export async function getFanCap(fanId: string, now: Date = new Date()): Promise<FanCap> {
  const platformCap = await getConfig<number>("wallet.daily_cap_cents");
  return withTx(async (tx) => {
    await lockWallet(tx, fanId);
    return effectiveCap(tx, fanId, platformCap, now);
  });
}
