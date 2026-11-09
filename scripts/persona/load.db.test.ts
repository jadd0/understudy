import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { creators, personaCards, personaChunks } from "@/db/schema";
import { loadPersona, neverList, neverTerms } from "@/scripts/persona/load";
import { makeUser } from "@/db/test-helpers";

const CARD = "## Identity\nhi\n\n## Never\n- Never give contact details.\n- Never meet up.\n\n## Selling voice\nx\n";
const vec = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
const fakeEmbed = async (texts: string[]) => ({ embeddings: texts.map(() => vec), totalTokens: texts.length * 3 });

function fixture(over: { chunkIds?: string[]; card?: string; testIds?: string[] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "persona-"));
  mkdirSync(path.join(dir, "bank"));
  mkdirSync(path.join(dir, "card"));
  const ids = over.chunkIds ?? ["cap_a", "cap_b", "rep_r1", "rep_r2"];
  const rows = ids.map((id) => ({
    id,
    source: id.startsWith("cap_") ? "caption" : "comment_reply",
    source_url: `https://x/${id}`,
    date: "2026-01-01",
    post_shortcode: "P",
    split: id.startsWith("rep_") ? "train" : null,
    text: `text of ${id}`,
  }));
  writeFileSync(path.join(dir, "bank", "chunks.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(
    path.join(dir, "bank", "splits.json"),
    JSON.stringify({ replies: { train: ["r1", "r2"], validation: ["v1"], test: over.testIds ?? ["t1"], style_only: [] } }),
  );
  writeFileSync(path.join(dir, "card", "v1.md"), over.card ?? CARD);
  return dir;
}

async function mkCreator() {
  const u = await makeUser({ role: "creator" });
  const [c] = await db.insert(creators).values({ userId: u.id, handle: `h-${randomUUID()}`, displayName: "C" }).returning();
  return c.id;
}
const count = async (id: string) => (await db.select({ id: personaChunks.id }).from(personaChunks).where(eq(personaChunks.creatorId, id))).length;

describe("persona load", () => {
  test("neverList reads the bullets under ## Never only", () => {
    expect(neverList(CARD)).toEqual(["Never give contact details.", "Never meet up."]);
  });

  test("never_list_terms_from_card", () => {
    const card = [
      "## Never",
      "- Never give contact details: phone, email, Snapchat or any private handle.",
      "- Never give your home location: no neighbourhood, address, hotel, or venue.",
      "- Never agree to or plan a real-world meetup.",
      "- Never ask for or accept off-platform payment: no Cash App, Venmo, PayPal, gift cards or crypto.",
      "- Whatsapp",
      "- cash app",
      "## Selling voice",
      "- Never describe the item, phone or address.",
    ].join("\n");
    expect(neverTerms(card)).toEqual([
      "phone number", "email", "snapchat", "address", "meet up", "cash app", "venmo", "paypal", "gift card", "crypto", "Whatsapp",
    ]);
    expect(neverTerms("no never section")).toEqual([]);
    expect(neverTerms(CARD)).toEqual(["meet up"]);
  });

  test("loading twice leaves the same chunk count, embeddings set, one unpublished card", async () => {
    const creatorId = await mkCreator();
    const dir = fixture();
    const first = await loadPersona({ creatorId, dir, embedDocuments: fakeEmbed });
    expect(first).toMatchObject({ chunks: 4, tokens: 12, cardVersion: 1, cardInserted: true });
    const second = await loadPersona({ creatorId, dir, embedDocuments: fakeEmbed });
    expect(second).toMatchObject({ chunks: 4, cardVersion: 1, cardInserted: false });
    expect(await count(creatorId)).toBe(4);
    const rows = await db.select().from(personaChunks).where(eq(personaChunks.creatorId, creatorId));
    expect(rows.every((r) => r.embedding?.length === 1024)).toBe(true);
    expect(rows.map((r) => (r.meta as { chunk_id: string }).chunk_id).sort()).toEqual(["cap_a", "cap_b", "rep_r1", "rep_r2"]);
    const cards = await db.select().from(personaCards).where(eq(personaCards.creatorId, creatorId));
    expect(cards).toHaveLength(1);
    expect(cards[0].publishedAt).toBeNull();
    expect(cards[0].neverList).toEqual(["meet up"]);
  });

  test("loading the same card again re-derives its never list", async () => {
    const creatorId = await mkCreator();
    const dir = fixture();
    await loadPersona({ creatorId, dir, embedDocuments: fakeEmbed });
    await db.update(personaCards).set({ neverList: ["Never meet up."] }).where(eq(personaCards.creatorId, creatorId));
    await loadPersona({ creatorId, dir, embedDocuments: fakeEmbed });
    const cards = await db.select().from(personaCards).where(eq(personaCards.creatorId, creatorId));
    expect(cards).toHaveLength(1);
    expect(cards[0].neverList).toEqual(["meet up"]);
  });

  test("a changed card becomes the next version and never overwrites", async () => {
    const creatorId = await mkCreator();
    await loadPersona({ creatorId, dir: fixture(), embedDocuments: fakeEmbed });
    await loadPersona({ creatorId, dir: fixture({ card: CARD + "more\n" }), embedDocuments: fakeEmbed });
    const cards = await db.select().from(personaCards).where(eq(personaCards.creatorId, creatorId)).orderBy(desc(personaCards.version));
    expect(cards.map((c) => c.version)).toEqual([2, 1]);
    expect(cards[1].body).toBe(CARD);
  });

  test("a held-out reply in the input aborts with nothing written and no embedding call", async () => {
    const creatorId = await mkCreator();
    await loadPersona({ creatorId, dir: fixture(), embedDocuments: fakeEmbed });
    let called = 0;
    const spy = async (t: string[]) => (called++, fakeEmbed(t));
    const dir = fixture({ chunkIds: ["cap_a", "rep_t1"], testIds: ["t1"] });
    await expect(loadPersona({ creatorId, dir, embedDocuments: spy })).rejects.toThrow(/held-out/);
    expect(called).toBe(0);
    expect(await count(creatorId)).toBe(4);
  });

  test("a failure inside the transaction rolls back the delete", async () => {
    const creatorId = await mkCreator();
    await loadPersona({ creatorId, dir: fixture(), embedDocuments: fakeEmbed });
    const bad = async (t: string[]) => ({ embeddings: t.map(() => [1, 2, 3]), totalTokens: 0 });
    await expect(loadPersona({ creatorId, dir: fixture({ card: CARD + "z" }), embedDocuments: bad })).rejects.toThrow();
    expect(await count(creatorId)).toBe(4);
  });
});
