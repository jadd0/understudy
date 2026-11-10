// Publishes a persona card: the engine speaks only with the newest *published* card (packages/engine/src/turn/run.ts).
//   npm run persona:publish -- --creator junovale --card-version 2 [--dir <persona directory, default data/persona>]
// In one transaction: if a stored version already has this exact body it is published; otherwise the body is
// inserted as the next version, published. Earlier versions stay as history. Re-running is a no-op.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { creators, personaCards } from "@/db/schema";
import { neverTerms, readMarkers } from "./load";

export type PublishResult = { version: number; inserted: boolean; alreadyPublished: boolean };

/** `markers` are her measured voice-marker rates; left out, the stored ones are not touched. */
export async function publishCard(creatorId: string, body: string, markers?: Record<string, unknown> | null): Promise<PublishResult> {
  const stored = markers === undefined ? {} : { markers };
  return db.transaction(async (tx) => {
    // Serialise publishes for one creator so two runs cannot both take the same next version.
    await tx.execute(sql`select id from creators where id = ${creatorId} for update`);
    const [same] = await tx
      .select({ version: personaCards.version, publishedAt: personaCards.publishedAt })
      .from(personaCards)
      .where(and(eq(personaCards.creatorId, creatorId), eq(personaCards.body, body)))
      .orderBy(desc(personaCards.version))
      .limit(1);
    const terms = neverTerms(body);
    if (same) {
      // The stored terms are re-derived on every publish, as the loader does, so both writers agree.
      if (same.publishedAt) {
        await tx
          .update(personaCards)
          .set({ neverList: terms, ...stored })
          .where(and(eq(personaCards.creatorId, creatorId), eq(personaCards.version, same.version)));
        return { version: same.version, inserted: false, alreadyPublished: true };
      }
      await tx
        .update(personaCards)
        .set({ publishedAt: sql`now()`, neverList: terms, ...stored })
        .where(and(eq(personaCards.creatorId, creatorId), eq(personaCards.version, same.version)));
      return { version: same.version, inserted: false, alreadyPublished: false };
    }
    const [latest] = await tx
      .select({ version: personaCards.version })
      .from(personaCards)
      .where(eq(personaCards.creatorId, creatorId))
      .orderBy(desc(personaCards.version))
      .limit(1);
    const version = (latest?.version ?? 0) + 1;
    await tx.insert(personaCards).values({ creatorId, version, body, neverList: terms, ...stored, publishedAt: sql`now()` as unknown as Date });
    return { version, inserted: true, alreadyPublished: false };
  });
}

async function main() {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const handle = arg("creator");
  const fileVersion = Number(arg("card-version"));
  if (!handle || !Number.isInteger(fileVersion) || fileVersion < 1)
    throw new Error("usage: npm run persona:publish -- --creator <handle> --card-version <n>");
  console.log(`database host: ${new URL(process.env.DATABASE_URL ?? "").host}`);
  const [creator] = await db.select({ id: creators.id }).from(creators).where(eq(creators.handle, handle));
  if (!creator) throw new Error(`no creator with handle ${handle}; run npm run db:seed first`);
  const dir = path.resolve(arg("dir") ?? "data/persona");
  const body = readFileSync(path.join(dir, "card", `v${fileVersion}.md`), "utf8");
  const res = await publishCard(creator.id, body, readMarkers(dir));
  console.log(
    `card file v${fileVersion} → stored version ${res.version}: ${res.alreadyPublished ? "already published" : res.inserted ? "inserted and published" : "published"}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
