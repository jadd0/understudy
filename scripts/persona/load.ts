import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { creators, personaCards, personaChunks } from "@/db/schema";
import { getConfig } from "@/lib/config";
import { embed, VoyageError, type EmbedResult } from "@/providers/voyage/embed";

type BankChunk = {
  id: string;
  source: "caption" | "comment_reply";
  source_url: string | null;
  date: string | null;
  post_shortcode: string | null;
  split: string | null;
  text: string;
};

// Voyage accounts without a payment method get 3 requests and 10K tokens a minute.
export const UNBILLED_LIMITS = { batchSize: 100, intervalMs: 21_000, retries: 5, retryDelayMs: 30_000 };

export type LoadInput = {
  creatorId: string;
  /** `data/persona` directory of the creator being loaded. */
  dir: string;
  embedDocuments: (texts: string[]) => Promise<EmbedResult>;
};
export type LoadResult = { chunks: number; tokens: number; cardVersion: number; cardInserted: boolean };

const jsonl = <T>(file: string): T[] =>
  readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);

/** Highest N among `v<N>.md` card files in `dir`. */
export function latestCardVersion(dir: string): number {
  const versions = readdirSync(dir)
    .map((f) => /^v(\d+)\.md$/.exec(f)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number);
  if (versions.length === 0) throw new Error(`no v<N>.md card in ${dir}`);
  return Math.max(...versions);
}

/** Bullets under the card's "## Never" heading, without the marker. */
export function neverList(card: string): string[] {
  const rest = card.split(/^## Never\s*$/m)[1] ?? "";
  const section = rest.split(/^## /m)[0];
  return section.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
}

/**
 * What a Never bullet names that a draft must not contain, for the verify code check. Each entry is a short term
 * stored as written below; the pattern finds it in a long bullet.
 */
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

/** A bullet that is already a short term (a few words, not a sentence) is used as it stands. */
const isShortTerm = (bullet: string) => bullet.split(/\s+/).length <= 3 && !/[.:;!?]/.test(bullet) && !/^never\b/i.test(bullet);

/**
 * The terms the verify check matches in a draft, derived from the card's Never bullets: short bullets as they
 * are, sentences through the lexicon above. The card still carries the full sentences for the model; the stored
 * `never_list` holds only terms, so the code check is not inert.
 */
export function neverTerms(card: string): string[] {
  const out: string[] = [];
  const add = (t: string) => {
    if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  for (const bullet of neverList(card)) {
    if (isShortTerm(bullet)) add(bullet);
    else for (const { term, pattern } of NEVER_LEXICON) if (pattern.test(bullet)) add(term);
  }
  return out;
}

/**
 * One transaction replaces the creator's chunks, so loading twice leaves the same rows. The newest card file
 * (`card/v<N>.md`, highest N) is inserted as the next version, unpublished, unless the newest stored version
 * already has the same body. Publishing is a separate, deliberate step (`publish-card.ts`).
 */
export async function loadPersona(input: LoadInput): Promise<LoadResult> {
  const bank = path.join(input.dir, "bank");
  const chunks = jsonl<BankChunk>(path.join(bank, "chunks.jsonl"));
  if (chunks.length === 0) throw new Error("chunks.jsonl is empty");

  // Held-out replies must never be retrievable: abort before any embedding call or write.
  const splits = JSON.parse(readFileSync(path.join(bank, "splits.json"), "utf8")) as { replies: Record<string, string[]> };
  const heldOut = new Set([...splits.replies.test, ...splits.replies.validation]);
  const leaked = chunks.filter((c) => c.source === "comment_reply" && heldOut.has(c.id.replace(/^rep_/, "")));
  if (leaked.length > 0 || chunks.some((c) => c.split === "test" || c.split === "validation"))
    throw new Error(`held-out reply in chunks.jsonl (${leaked.length}); nothing written`);
  if (new Set(chunks.map((c) => c.id)).size !== chunks.length) throw new Error("duplicate chunk id; nothing written");

  const { embeddings, totalTokens } = await input.embedDocuments(chunks.map((c) => c.text));
  if (embeddings.length !== chunks.length) throw new Error("embedding count mismatch; nothing written");

  const cardBody = readFileSync(path.join(input.dir, "card", `v${latestCardVersion(path.join(input.dir, "card"))}.md`), "utf8");

  return db.transaction(async (tx) => {
    await tx.delete(personaChunks).where(eq(personaChunks.creatorId, input.creatorId));
    for (let i = 0; i < chunks.length; i += 100) {
      await tx.insert(personaChunks).values(
        chunks.slice(i, i + 100).map((c, j) => ({
          creatorId: input.creatorId,
          source: c.source,
          sourceUrl: c.source_url,
          text: c.text,
          meta: { chunk_id: c.id, date: c.date, post_shortcode: c.post_shortcode, split: c.split },
          embedding: embeddings[i + j],
        })),
      );
    }
    const [latest] = await tx
      .select({ version: personaCards.version, body: personaCards.body })
      .from(personaCards)
      .where(eq(personaCards.creatorId, input.creatorId))
      .orderBy(desc(personaCards.version))
      .limit(1);
    const terms = neverTerms(cardBody);
    if (latest && latest.body === cardBody) {
      // The same card: re-derive its terms so a change to the extraction reaches the stored list.
      await tx
        .update(personaCards)
        .set({ neverList: terms })
        .where(and(eq(personaCards.creatorId, input.creatorId), eq(personaCards.version, latest.version)));
      return { chunks: chunks.length, tokens: totalTokens, cardVersion: latest.version, cardInserted: false };
    }
    const version = (latest?.version ?? 0) + 1;
    await tx.insert(personaCards).values({ creatorId: input.creatorId, version, body: cardBody, neverList: terms, publishedAt: null });
    return { chunks: chunks.length, tokens: totalTokens, cardVersion: version, cardInserted: true };
  });
}

async function main() {
  const i = process.argv.indexOf("--creator");
  const handle = i >= 0 ? process.argv[i + 1] : undefined;
  if (!handle) throw new Error("usage: npm run persona:load -- --creator <handle>");
  console.log(`database host: ${new URL(process.env.DATABASE_URL ?? "").host}`);
  const [creator] = await db.select({ id: creators.id }).from(creators).where(eq(creators.handle, handle));
  if (!creator) throw new Error(`no creator with handle ${handle}; run npm run db:seed first`);
  const model = await getConfig<string>("retrieval.voyage_model");
  const res = await loadPersona({
    creatorId: creator.id,
    dir: path.resolve("data/persona"),
    embedDocuments: (texts) => embed(texts, "document", { model, ...UNBILLED_LIMITS }),
  });
  console.log(`model: ${model}`);
  console.log(`chunks loaded: ${res.chunks}`);
  console.log(`embedding tokens: ${res.tokens}`);
  console.log(`card: v${res.cardVersion} ${res.cardInserted ? "inserted (unpublished)" : "unchanged"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("persona:load failed:", (e as { code?: string; name?: string }).code ?? (e as Error).name, e instanceof VoyageError ? `status ${e.status}` : "");
      process.exit(1);
    });
}
