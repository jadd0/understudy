import { eq } from "drizzle-orm";
import type { EngineDb } from "../ports/db";
import { creatorSettings } from "../db/schema";

/** Switches the AI on or off for every conversation of one creator. Idempotent. Takes no conversation lock. */
export async function setCreatorAi(db: EngineDb, creatorId: string, on: boolean): Promise<void> {
  await db
    .insert(creatorSettings)
    .values({ creatorId, aiEnabled: on })
    .onConflictDoUpdate({ target: creatorSettings.creatorId, set: { aiEnabled: on, updatedAt: new Date() } });
}

/** Whether the creator's AI is on. A creator with no settings row is on. */
export async function creatorAi(db: EngineDb, creatorId: string): Promise<boolean> {
  const [row] = await db.select({ on: creatorSettings.aiEnabled }).from(creatorSettings).where(eq(creatorSettings.creatorId, creatorId));
  return row?.on ?? true;
}
