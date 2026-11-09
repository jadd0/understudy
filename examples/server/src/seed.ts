import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { and, desc, eq, sql } from "drizzle-orm";
import type { EngineDb } from "@understudy/engine";
import { personaCards, personaChunks } from "@understudy/engine/schema";
import { connect } from "./db";
import { readConfigFile } from "./config";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_DIR = path.resolve(here, "..");
/** Juno's persona files: the repository's `data/persona`, or wherever `PERSONA_DIR` points. */
export const defaultPersonaDir = () => process.env.PERSONA_DIR ?? path.resolve(SERVER_DIR, "..", "..", "data", "persona");

interface BankChunk {
  id: string;
  source: "caption" | "comment_reply";
  source_url: string | null;
  date: string | null;
  post_shortcode: string | null;
  split: string | null;
  text: string;
}

// What a Never bullet names that a draft must not contain, for the engine's code check of a reply.
const NEVER_LEXICON: { term: string; pattern: RegExp }[] = [
  { term: "phone number", pattern: /\bphone\b/i },
  { term: "email", pattern: /\be-?mail\b/i },
  { term: "snapchat", pattern: /\bsnap(?:chat)?\b/i },
  { term: "whatsapp", pattern: /\bwhats\s?app\b/i },
  { term: "telegram", pattern: /\btelegram\b/i },
  { term: "address", pattern: /\baddress\b/i },
  { term: "meet up", pattern: /\bmeet\s?-?up\b/i },
  { term: "cash app", pattern: /\bcash\s?app\b/i },
  { term: "venmo", pattern: /\bvenmo\b/i },
  { term: "paypal", pattern: /\bpay\s?pal\b/i },
  { term: "gift card", pattern: /\bgift\s?cards?\b/i },
  { term: "crypto", pattern: /\bcrypto\b/i },
];

/** The terms the card's Never bullets name; the card keeps the full sentences for the model. */
export function neverTerms(card: string): string[] {
  const section = (card.split(/^## Never\s*$/m)[1] ?? "").split(/^## /m)[0];
  const bullets = section.split("\n").filter((l) => l.startsWith("- "));
  return NEVER_LEXICON.filter(({ pattern }) => bullets.some((b) => pattern.test(b))).map((l) => l.term);
}

function latestCard(dir: string): string {
  const versions = readdirSync(path.join(dir, "card"))
    .map((f) => /^v(\d+)\.md$/.exec(f)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number);
  if (versions.length === 0) throw new Error(`no v<N>.md card in ${dir}/card`);
  return readFileSync(path.join(dir, "card", `v${Math.max(...versions)}.md`), "utf8");
}

export interface SeedResult {
  cardVersion: number;
  cardInserted: boolean;
  chunks: number;
}

/**
 * Gives the creator her published card and her chunks (no embeddings: retrieval is full text). Idempotent: a card
 * whose body is already published is kept, and the chunks are replaced as a set.
 */
export async function seedPersona(db: EngineDb, creatorId: string, dir = defaultPersonaDir(), opts: { scripted?: boolean } = {}): Promise<SeedResult> {
  const body = latestCard(dir);
  const chunks = readFileSync(path.join(dir, "bank", "chunks.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as BankChunk)
    // Held-out replies are never retrievable.
    .filter((c) => c.split !== "test" && c.split !== "validation");
  if (chunks.length === 0) throw new Error("chunks.jsonl holds no chunk to load");
  // Her measured voice-marker rates, when the persona build wrote them: the card then draws a style per reply.
  const styleFile = path.join(dir, "bank", "style.json");
  const stored = existsSync(styleFile) ? ((JSON.parse(readFileSync(styleFile, "utf8")) as { markers?: Record<string, unknown> }).markers ?? null) : null;
  // Scripted providers answer from a fixed list of two-bubble replies that name her pet. Her real length, line and pet
  // limits would join and retry them, advancing the script, so a scripted seed leaves those limits out.
  const markers = opts.scripted && stored ? { ...stored, multiline: undefined, length_chars: undefined, pet: null } : stored;

  return db.transaction(async (tx) => {
    const [same] = await tx
      .select({ version: personaCards.version, publishedAt: personaCards.publishedAt })
      .from(personaCards)
      .where(and(eq(personaCards.creatorId, creatorId), eq(personaCards.body, body)))
      .orderBy(desc(personaCards.version))
      .limit(1);
    let version: number;
    let inserted = false;
    if (same) {
      version = same.version;
      if (!same.publishedAt) await tx.update(personaCards).set({ publishedAt: sql`now()`, markers }).where(and(eq(personaCards.creatorId, creatorId), eq(personaCards.version, version)));
    } else {
      const [latest] = await tx.select({ version: personaCards.version }).from(personaCards).where(eq(personaCards.creatorId, creatorId)).orderBy(desc(personaCards.version)).limit(1);
      version = (latest?.version ?? 0) + 1;
      await tx.insert(personaCards).values({ creatorId, version, body, neverList: neverTerms(body), markers, publishedAt: sql`now()` as unknown as Date });
      inserted = true;
    }
    await tx.delete(personaChunks).where(eq(personaChunks.creatorId, creatorId));
    for (let i = 0; i < chunks.length; i += 100) {
      await tx.insert(personaChunks).values(
        chunks.slice(i, i + 100).map((c) => ({
          creatorId,
          source: c.source,
          sourceUrl: c.source_url,
          text: c.text,
          meta: { chunk_id: c.id, date: c.date, post_shortcode: c.post_shortcode },
        })),
      );
    }
    return { cardVersion: version, cardInserted: inserted, chunks: chunks.length };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("seed: DATABASE_URL is not set");
    process.exit(1);
  }
  const { db, end } = connect(url);
  seedPersona(db, readConfigFile(path.join(SERVER_DIR, "config.json")).creatorId)
    .then((r) => console.log(`seed: card v${r.cardVersion}${r.cardInserted ? " published" : " already published"}, ${r.chunks} chunks`))
    .catch((e) => {
      console.error("seed failed:", (e as { code?: string; name?: string }).code ?? (e as Error).name);
      process.exitCode = 1;
    })
    .finally(() => void end());
}
