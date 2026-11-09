import { eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { users } from "@/db/schema";
import { NotAllowed } from "./errors";

/**
 * Only an unflagged fan may spend. The user row is read inside the caller's transaction with a share lock, so a
 * flag written concurrently waits for the spend to finish, or is seen by it. Call after the wallet lock.
 */
export async function assertFanMaySpend(tx: Tx, fanId: string): Promise<void> {
  const [u] = await tx
    .select({ role: users.role, flaggedAt: users.flaggedAt })
    .from(users)
    .where(eq(users.id, fanId))
    .for("share");
  if (!u || u.role !== "fan" || u.flaggedAt) throw new NotAllowed();
}
