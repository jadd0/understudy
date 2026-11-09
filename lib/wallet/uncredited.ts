import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { uncreditedPayments } from "@/db/schema";

export type UncreditedPayment = typeof uncreditedPayments.$inferSelect;

/** Paid Checkout events that credited nobody and still wait for a person (newest first). Admin reads only. */
export async function listOpenUncredited(limit = 50): Promise<UncreditedPayment[]> {
  return db
    .select()
    .from(uncreditedPayments)
    .where(isNull(uncreditedPayments.resolvedAt))
    .orderBy(desc(uncreditedPayments.createdAt))
    .limit(limit);
}

/** Marks a row handled (refunded in Stripe, or credited by hand). Returns false when it was already resolved or absent. */
export async function resolveUncredited(id: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(uncreditedPayments)
    .set({ resolvedAt: now })
    .where(and(eq(uncreditedPayments.id, id), isNull(uncreditedPayments.resolvedAt)))
    .returning({ id: uncreditedPayments.id });
  return rows.length === 1;
}
