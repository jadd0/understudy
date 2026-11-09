import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { withTx, type Tx } from "@/db/client";
import { ledgerEntries, users } from "@/db/schema";
import { getConfig } from "@/lib/config";
import { InvalidAmount } from "./errors";
import { lockWallet, setBalance } from "./ledger";

export type GrantOutcome = "granted" | "already_granted" | "ineligible";

/** Reads the welcome credit from config (fail closed); a non-whole or non-positive amount is refused. */
export async function welcomeCreditCents(): Promise<number> {
  const cents = await getConfig<number>("wallet.welcome_credit_cents");
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new InvalidAmount();
  return cents;
}

/**
 * Gives an adult, unflagged fan the one-time welcome credit inside `tx`. The wallet row lock serialises
 * concurrent calls and the unique key `welcome:<fanId>` makes a repeat a no-op, so the credit lands once.
 * It is a `grant` entry, never a top-up: it is not revenue and no Stripe event stands behind it.
 * The caller reads `amountCents` (welcomeCreditCents) before opening the transaction.
 */
export async function grantWelcomeCredit(tx: Tx, fanId: string, amountCents: number): Promise<GrantOutcome> {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new InvalidAmount();
  const eligible = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, fanId), eq(users.role, "fan"), isNotNull(users.adultConfirmedAt), isNull(users.flaggedAt)));
  if (eligible.length === 0) return "ineligible";

  await lockWallet(tx, fanId);
  const [entry] = await tx
    .insert(ledgerEntries)
    .values({ fanId, kind: "grant", amountCents, idempotencyKey: `welcome:${fanId}` })
    .onConflictDoNothing({ target: ledgerEntries.idempotencyKey })
    .returning({ id: ledgerEntries.id });
  if (!entry) return "already_granted";
  await setBalance(tx, fanId, amountCents);
  return "granted";
}

/** Own-transaction form for callers outside one (the seed backfill). */
export async function grantWelcomeCreditOnce(fanId: string): Promise<GrantOutcome> {
  const amount = await welcomeCreditCents();
  return withTx((tx) => grantWelcomeCredit(tx, fanId, amount));
}
