import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";

/**
 * A demo seat may sign in only once the seed has created its account with the seat's role:
 * `SEED_CREATOR_EMAIL` must already be a `creator`, each `SEED_ADMIN_EMAILS` address an `admin`.
 * Without this, a seat signing in before the seed ran would make Auth.js's adapter create a
 * default `fan` row that then owns the seat email.
 */
export function expectedSeatRole(email: string, env: NodeJS.ProcessEnv = process.env): "creator" | "admin" | null {
  const e = email.trim().toLowerCase();
  if (e && e === (env.SEED_CREATOR_EMAIL ?? "").trim().toLowerCase()) return "creator";
  const admins = (env.SEED_ADMIN_EMAILS ?? "").split(",").map((a) => a.trim().toLowerCase()).filter(Boolean);
  return admins.includes(e) ? "admin" : null;
}

export async function seatAccountReady(email: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const role = expectedSeatRole(email, env);
  if (!role) return false;
  const [row] = await db
    .select({ role: users.role, flaggedAt: users.flaggedAt })
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  return row?.role === role && row.flaggedAt === null;
}
