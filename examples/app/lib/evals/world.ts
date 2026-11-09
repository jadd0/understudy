import { globSync, readFileSync } from "node:fs";
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { config, creators, personaCards, users } from "@/db/schema";
import { ENGINE_CONFIG, seed } from "@/db/seed";
import { neverTerms } from "@/scripts/persona/load";
import { assertEvalDatabase } from "./runner";

export const EVAL_CREATOR_EMAIL = "eval-creator@understudy.test";

/** The newest card file in the repo: the eval measures what would be published next. */
export function newestCard(): { version: number; path: string } {
  const cards = globSync("data/persona/card/v*.md")
    .map((path) => ({ path, version: Number(/v(\d+)\.md$/.exec(path)?.[1]) }))
    .filter((c) => Number.isInteger(c.version));
  if (cards.length === 0) throw new Error("no persona card file in data/persona/card");
  return cards.sort((a, b) => b.version - a.version)[0];
}

/**
 * Makes the eval database look like production for the engine: platform config, Juno with her catalogue, and
 * her current persona card, published (the engine reads only a published card). Idempotent. Retrieval finds nothing here (no chunks are loaded), so replies lean
 * on the card alone; that is stated in the report.
 */
export async function prepareEvalWorld(): Promise<{ creatorId: string; cardVersion: number }> {
  assertEvalDatabase();
  await seed({ creatorEmail: EVAL_CREATOR_EMAIL }, () => {});
  const [creator] = await db
    .select({ id: creators.id })
    .from(creators)
    .innerJoin(users, eq(users.id, creators.userId))
    .where(eq(users.email, EVAL_CREATOR_EMAIL));

  const CARD = newestCard();
  const [have] = await db
    .select({ id: personaCards.id })
    .from(personaCards)
    .where(and(eq(personaCards.creatorId, creator.id), eq(personaCards.version, CARD.version)));
  if (!have) {
    const body = readFileSync(CARD.path, "utf8");
    await db.insert(personaCards).values({ creatorId: creator.id, version: CARD.version, body, neverList: neverTerms(body), publishedAt: new Date() });
  }

  // The seed never overwrites a row, so an eval database keeps the values of the run that created it. The debounce
  // and the chat window are under test now, so they are set to what the engine ships with.
  for (const key of ["engine.debounce_ms", "engine.history_rounds", "engine.jev_context_rounds"]) {
    const value = ENGINE_CONFIG[key];
    await db.insert(config).values({ key, value }).onConflictDoUpdate({ target: [config.key, config.creatorId], set: { value } });
  }
  return { creatorId: creator.id, cardVersion: CARD.version };
}
