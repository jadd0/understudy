import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { creators, users } from "@/db/schema";

/**
 * What a viewer may read. `includeTs` lets Trust & Safety (admins) see conversations that belong to the T&S
 * queue; a creator never does. Every analytics query takes one of these, never a list a page made up.
 */
export interface Scope {
  creatorIds: string[];
  includeTs: boolean;
  /** Eval-run fans (email eval+...@understudy.test) are left out unless a caller asks for them. */
  includeEval?: boolean;
  /** Sim fans (users.is_sim): all (default), exclude them, or show only them. */
  sim?: SimFilter;
}

export type SimFilter = "all" | "exclude" | "only";
export const isSimFilter = (v: unknown): v is SimFilter => v === "all" || v === "exclude" || v === "only";

export class AnalyticsForbidden extends Error {
  constructor() {
    super("analytics is for creators and admins");
    this.name = "AnalyticsForbidden";
  }
}

/** Reads the role fresh from the user row. A creator gets their own creator id, an admin all of them, a fan throws. */
export async function analyticsScope(viewerId: string): Promise<Scope> {
  const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, viewerId));
  if (user?.role === "creator") {
    const rows = await db.select({ id: creators.id }).from(creators).where(eq(creators.userId, viewerId));
    return { creatorIds: rows.map((r) => r.id), includeTs: false };
  }
  if (user?.role === "admin") {
    const rows = await db.select({ id: creators.id }).from(creators);
    return { creatorIds: rows.map((r) => r.id), includeTs: true };
  }
  throw new AnalyticsForbidden();
}
