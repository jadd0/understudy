import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { sessions, users } from "@/db/schema";
import { grantWelcomeCredit, welcomeCreditCents } from "@/lib/wallet/grant";
import { isAdult, parseDob } from "./age";

export type OnboardingResult =
  | { status: "confirmed" }
  | { status: "blocked" }
  | { status: "invalid_dob" }
  | { status: "unconfirmed" }
  | { status: "unchanged" };

/**
 * Fan age gate. The age is computed here, in UTC, from the submitted date; `now` is injected.
 * dob and adult_confirmed_at are written once: the update only matches a fan with no dob and no flag.
 * The welcome credit is granted in the same transaction as the confirmation, so a fan is never adult without it.
 */
export async function applyOnboarding(
  userId: string,
  input: { dob: unknown; adult: boolean },
  now: Date,
): Promise<OnboardingResult> {
  const dob = parseDob(input.dob, now);
  if (!dob) return { status: "invalid_dob" };
  const adult = isAdult(dob, now);
  // A declared under-18 date is acted on even if the box is unticked.
  if (adult && !input.adult) return { status: "unconfirmed" };

  const welcomeCents = adult ? await welcomeCreditCents() : 0;

  return db.transaction(async (tx) => {
    const fresh = and(eq(users.id, userId), eq(users.role, "fan"), isNull(users.dob), isNull(users.flaggedAt));
    if (!adult) {
      const flagged = await tx
        .update(users)
        .set({ dob, flaggedAt: now, flagReason: "under_18_declared" })
        .where(fresh)
        .returning({ id: users.id });
      if (flagged.length === 0) return { status: "unchanged" };
      await tx.delete(sessions).where(eq(sessions.userId, userId));
      return { status: "blocked" };
    }
    const confirmed = await tx
      .update(users)
      .set({ dob, adultConfirmedAt: now })
      .where(fresh)
      .returning({ id: users.id });
    if (confirmed.length !== 1) return { status: "unchanged" };
    await grantWelcomeCredit(tx, userId, welcomeCents);
    return { status: "confirmed" };
  });
}
