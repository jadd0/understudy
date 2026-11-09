import { and, eq, or, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { ledgerEntries, wallets } from "@/db/schema";
import { assertWithinCap } from "./cap";
import { InsufficientFunds, InvalidAmount } from "./errors";

export type LedgerKind = typeof ledgerEntries.$inferInsert.kind;

export type LedgerResult = {
  ledgerEntryId: string;
  balanceCents: number;
  /** True when an earlier call with the same event id or idempotency key already did this; nothing was written. */
  replayed: boolean;
};

const assertCents = (n: number) => {
  if (!Number.isSafeInteger(n) || n <= 0) throw new InvalidAmount();
};

/** Creates the wallet if absent, then takes its row lock; returns the locked balance. Every balance change starts here. */
export async function lockWallet(tx: Tx, fanId: string): Promise<number> {
  await tx.insert(wallets).values({ fanId }).onConflictDoNothing();
  const [row] = await tx
    .select({ balanceCents: wallets.balanceCents })
    .from(wallets)
    .where(eq(wallets.fanId, fanId))
    .for("update");
  return row.balanceCents;
}

export async function setBalance(tx: Tx, fanId: string, delta: number): Promise<number> {
  const [row] = await tx
    .update(wallets)
    .set({ balanceCents: sql`${wallets.balanceCents} + ${delta}`, updatedAt: sql`now()` })
    .where(eq(wallets.fanId, fanId))
    .returning({ balanceCents: wallets.balanceCents });
  return row.balanceCents;
}

export type CreditInput = {
  fanId: string;
  kind: "topup" | "refund";
  amountCents: number;
  stripeEventId?: string;
  /** The Checkout session being paid for; a second event for the same session is a no-op. */
  stripeSessionId?: string;
};

/** Adds money. A repeated stripeEventId or stripeSessionId is a no-op that reports `replayed`. Run inside withTx. */
export async function credit(tx: Tx, input: CreditInput): Promise<LedgerResult> {
  assertCents(input.amountCents);
  const balance = await lockWallet(tx, input.fanId);
  const [entry] = await tx
    .insert(ledgerEntries)
    .values({
      fanId: input.fanId,
      kind: input.kind,
      amountCents: input.amountCents,
      stripeEventId: input.stripeEventId,
      stripeSessionId: input.stripeSessionId,
    })
    // No target: the event id and the session id are both unique and either one means "already credited".
    .onConflictDoNothing()
    .returning({ id: ledgerEntries.id });
  if (!entry) {
    const seen = [
      input.stripeEventId ? eq(ledgerEntries.stripeEventId, input.stripeEventId) : undefined,
      input.stripeSessionId ? eq(ledgerEntries.stripeSessionId, input.stripeSessionId) : undefined,
    ].filter((c) => c !== undefined);
    const [first] = await tx
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(or(...seen));
    return { ledgerEntryId: first.id, balanceCents: balance, replayed: true };
  }
  return { ledgerEntryId: entry.id, balanceCents: await setBalance(tx, input.fanId, input.amountCents), replayed: false };
}

export type DebitInput = {
  fanId: string;
  kind: "unlock" | "tip";
  creatorId: string;
  amountCents: number;
  /** Platform default daily cap, read from config by the caller before it opens the transaction; a fan's own cap overrides it. */
  platformCapCents: number;
  offerId?: string;
  conversationId?: string;
  /** Unique per fan (stored prefixed with the fan id); a repeat returns the first entry and charges nothing. */
  idempotencyKey?: string;
  /** Clock for the cap's cooling-off check; defaults to the process clock. */
  now?: Date;
};

/** Removes money under the wallet row lock: never below zero, never past the daily cap. Run inside withTx. */
export async function debit(tx: Tx, input: DebitInput): Promise<LedgerResult> {
  assertCents(input.amountCents);
  const balance = await lockWallet(tx, input.fanId);
  // Keys are unique in the table, so scope them to the fan: two fans may reuse the same client key.
  const key = input.idempotencyKey ? `${input.fanId}:${input.idempotencyKey}` : undefined;
  if (key) {
    const [first] = await tx
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.fanId, input.fanId), eq(ledgerEntries.idempotencyKey, key)));
    if (first) return { ledgerEntryId: first.id, balanceCents: balance, replayed: true };
  }
  if (balance < input.amountCents) throw new InsufficientFunds();
  await assertWithinCap(tx, input.fanId, input.amountCents, input.platformCapCents, input.now ?? new Date());
  const [entry] = await tx
    .insert(ledgerEntries)
    .values({
      fanId: input.fanId,
      creatorId: input.creatorId,
      kind: input.kind,
      amountCents: -input.amountCents,
      offerId: input.offerId,
      conversationId: input.conversationId,
      idempotencyKey: key,
    })
    .returning({ id: ledgerEntries.id });
  return { ledgerEntryId: entry.id, balanceCents: await setBalance(tx, input.fanId, -input.amountCents), replayed: false };
}

/** Balance as the ledger sums it; must always equal wallets.balance_cents. */
export async function ledgerSum(tx: Tx, fanId: string): Promise<number> {
  const { rows } = await tx.execute(
    sql`select coalesce(sum(amount_cents), 0)::int as total from ledger_entries where fan_id = ${fanId}`,
  );
  return Number((rows[0] as { total: number }).total);
}
