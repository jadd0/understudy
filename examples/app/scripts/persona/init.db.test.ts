import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, asc, count, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { catalogueItems, creators, messages, offers, personaCards, personaChunks, turns, users } from "@/db/schema";
import { NOW, makeUser } from "@/db/test-helpers";
import { addMessage, makeConversation, makeFan, makeItem, rig, setEngineConfig, YES } from "@understudy/engine/testing";
import { NotOwnAccount } from "@understudy/persona";
import { fakeCardClaude, fixtureFetch, writeZip, type CardCall } from "@understudy/persona/testing";
import { ensureCreator, initDraft, initPublish, MIN_MARKER_TEXTS, type InitDeps } from "./init";
import { loadPersona } from "./load";

const FIXTURE = path.resolve(import.meta.dirname, "../../../../packages/persona/fixtures/instagram-export");
const CAPTION_FROM_FIXTURE = "first light on the pier before anyone else was awake";
const vec = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
const fakeEmbed = async (texts: string[]) => ({ embeddings: texts.map(() => vec), totalTokens: texts.length });
const ENV = { CLAUDE_SECRET_KEY: "test-key-not-real", IG_SESSIONID: "test-session-not-real" };

const tmp = (prefix: string) => mkdtempSync(path.join(tmpdir(), `init-${prefix}-`));

function filesUnder(root: string, rel = ""): string[] {
  return readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((entry) => {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesUnder(root, next) : [next];
  });
}

/** The fixture export for a fresh account, so each test owns its handle. `extraComments` adds her own text comments. */
function exportFor(handle: string, extraComments = 0) {
  const dir = path.join(tmp("export"), "download");
  cpSync(FIXTURE, dir, { recursive: true });
  for (const rel of ["personal_information/personal_information/personal_information.json", "comments/post_comments_1.json", "comments/reels_comments.json"]) {
    const file = path.join(dir, rel);
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("wren.fixture", handle));
  }
  if (extraComments > 0) {
    const file = path.join(dir, "comments/post_comments_1.json");
    const list = JSON.parse(readFileSync(file, "utf8")) as unknown[];
    for (let i = 0; i < extraComments; i++) {
      list.push({
        string_map_data: { Comment: { value: `her own line number ${i} about the pier` }, "Media Owner": { value: handle }, Time: { timestamp: 1714600100 + i * 60 } },
      });
    }
    writeFileSync(file, JSON.stringify(list));
  }
  return dir;
}

function zipOf(folder: string) {
  const file = path.join(tmp("zip"), "instagram-export.zip");
  writeZip(file, filesUnder(folder).map((name) => ({ name, data: readFileSync(path.join(folder, name)), method: name.endsWith(".json") ? 8 : 0 })));
  return file;
}

const newHandle = () => `w${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const newEmail = () => `${randomUUID()}@creator.test`;

function setup() {
  const lines: string[] = [];
  const calls: CardCall[] = [];
  const deps: InitDeps = {
    env: ENV,
    claude: fakeCardClaude({ calls }),
    leakTree: tmp("tree"),
    now: () => NOW,
    log: (line) => void lines.push(line),
    scrapeDelayMs: 0,
    embedDocuments: fakeEmbed,
  };
  return { deps, lines, calls, tree: deps.leakTree! };
}

const draftOf = (input: string, over: Partial<Parameters<typeof initDraft>[0]> = {}) => ({
  kind: "draft" as const,
  source: { kind: "export" as const, input },
  email: newEmail(),
  cardModel: "a-card-model",
  out: path.join(tmp("out"), "bank"),
  ...over,
});

const userRows = (email: string) => db.select().from(users).where(eq(users.email, email));
const creatorRows = (handle: string) => db.select().from(creators).where(eq(creators.handle, handle));
const countOf = async (table: typeof personaChunks | typeof catalogueItems, column: typeof personaChunks.creatorId | typeof catalogueItems.creatorId, id: string) =>
  (await db.select({ n: count() }).from(table).where(eq(column, id)))[0].n;
const cardsOf = (creatorId: string) => db.select().from(personaCards).where(eq(personaCards.creatorId, creatorId)).orderBy(asc(personaCards.version));

function editCard(out: string, change: (card: string) => string) {
  const file = path.join(out, "card", "v1.md");
  const edited = change(readFileSync(file, "utf8"));
  writeFileSync(file, edited);
  return edited;
}

describe("npx understudy init", () => {
  test("an Instagram export zip runs end to end with fake providers", async () => {
    const handle = newHandle();
    const email = newEmail();
    const { deps, calls, tree } = setup();
    const zip = zipOf(exportFor(handle));

    const drafted = await initDraft(draftOf(zip, { email }), deps);
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain("=== HER LINES");
    // Phase 1 writes no row.
    expect(await userRows(email)).toHaveLength(0);
    expect(await creatorRows(handle)).toHaveLength(0);
    const state = JSON.parse(readFileSync(path.join(drafted.out, "init.json"), "utf8"));
    expect(state).toMatchObject({ format: 1, source: "instagram-export", handle, display_name: "Wren Fixture", email, card_model: "a-card-model", published_at: null, creator_id: null });
    expect(state.drafted_at).toBe(NOW.toISOString());

    const edited = editCard(drafted.out, (card) => card.replace("- real-world meetups", "- real-world meetups\n- crypto"));
    expect(edited).toContain("- crypto");

    const published = await initPublish(drafted.out, deps);
    expect(published.edited).toBe(true);

    const [user] = await userRows(email);
    expect(user).toMatchObject({ role: "creator", email, name: "Wren Fixture", image: null });
    const [creator] = await creatorRows(handle);
    expect(creator).toMatchObject({ userId: user.id, displayName: "Wren Fixture" });
    expect(published.creatorId).toBe(creator.id);

    const chunks = await db.select().from(personaChunks).where(eq(personaChunks.creatorId, creator.id));
    expect(chunks).toHaveLength(5);
    expect(chunks.every((c) => c.source === "caption" && c.embedding?.length === 1024)).toBe(true);
    const cards = await cardsOf(creator.id);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ version: 1, body: edited });
    expect(cards[0].publishedAt).not.toBeNull();
    expect(cards[0].neverList).toContain("crypto");
    expect(await countOf(catalogueItems, catalogueItems.creatorId, creator.id)).toBe(0);

    const after = JSON.parse(readFileSync(path.join(drafted.out, "init.json"), "utf8"));
    expect(after).toMatchObject({ creator_id: creator.id, published_at: NOW.toISOString() });
    // The bank is outside the tree it was checked against.
    expect(existsSync(path.join(tree, "init.json"))).toBe(false);
  });

  test("publishing twice changes nothing", async () => {
    const handle = newHandle();
    const { deps } = setup();
    const drafted = await initDraft(draftOf(exportFor(handle)), deps);
    const first = await initPublish(drafted.out, deps);
    const [before] = await cardsOf(first.creatorId);
    const stateBefore = readFileSync(path.join(drafted.out, "init.json"), "utf8");

    const second = await initPublish(drafted.out, { ...deps, now: () => new Date(NOW.getTime() + 3_600_000) });
    expect(second).toMatchObject({ creatorId: first.creatorId, version: 1, chunks: 5, alreadyPublished: true });
    expect(await countOf(personaChunks, personaChunks.creatorId, first.creatorId)).toBe(5);
    expect(await creatorRows(handle)).toHaveLength(1);
    const cards = await cardsOf(first.creatorId);
    expect(cards).toHaveLength(1);
    expect(cards[0].publishedAt).toEqual(before.publishedAt);
    expect(readFileSync(path.join(drafted.out, "init.json"), "utf8")).toBe(stateBefore);
  });

  test("two publishes at once leave one creator, one set of chunks and one published card", async () => {
    const handle = newHandle();
    const email = newEmail();
    const { deps } = setup();
    const drafted = await initDraft(draftOf(exportFor(handle), { email }), deps);
    const both = await Promise.all([initPublish(drafted.out, deps), initPublish(drafted.out, deps)]);
    expect(both[0].creatorId).toBe(both[1].creatorId);
    expect(await userRows(email)).toHaveLength(1);
    expect(await creatorRows(handle)).toHaveLength(1);
    expect(await countOf(personaChunks, personaChunks.creatorId, both[0].creatorId)).toBe(5);
    const cards = await cardsOf(both[0].creatorId);
    expect(cards).toHaveLength(1);
    expect(cards[0].publishedAt).not.toBeNull();
  });

  test("a planted caption in the tree refuses both phases; no rows", async () => {
    const handle = newHandle();
    const email = newEmail();
    const { deps, tree } = setup();
    writeFileSync(path.join(tree, "notes.md"), `copied by mistake: ${CAPTION_FROM_FIXTURE}\n`);
    const refusedDraft = initDraft(draftOf(exportFor(handle), { email }), deps);
    await expect(refusedDraft).rejects.toThrow(/appears in 1 file/);

    // A tree that is clean at draft time and dirty at publish time.
    const clean = setup();
    const drafted = await initDraft(draftOf(exportFor(handle), { email }), clean.deps);
    writeFileSync(path.join(clean.tree, "notes.md"), `copied later: ${CAPTION_FROM_FIXTURE}\n`);
    await expect(initPublish(drafted.out, clean.deps)).rejects.toThrow(/appears in 1 file/);
    expect(await userRows(email)).toHaveLength(0);
    expect(await creatorRows(handle)).toHaveLength(0);
    // The leak check is what stopped it: with the file gone the same directory publishes.
    writeFileSync(path.join(clean.tree, "notes.md"), "fine\n");
    await initPublish(drafted.out, clean.deps);
    expect(await creatorRows(handle)).toHaveLength(1);
  });

  test("a file that only names one of her fans warns and does not block", async () => {
    const { deps, tree, lines } = setup();
    writeFileSync(path.join(tree, "thanks.md"), "thanks to moth_fan for the idea\n");
    const drafted = await initDraft(draftOf(exportFor(newHandle())), deps);
    expect(lines.some((line) => line.startsWith("warning: thanks.md"))).toBe(true);
    expect(existsSync(path.join(drafted.out, "init.json"))).toBe(true);
  });

  test("a taken handle refuses before any model call", async () => {
    const handle = newHandle();
    const owner = await makeUser({ role: "creator" });
    await db.insert(creators).values({ userId: owner.id, handle: handle.toUpperCase(), displayName: "Someone" });
    const { deps, calls } = setup();
    const out = path.join(tmp("out"), "bank");
    await expect(initDraft(draftOf(exportFor(handle), { out }), deps)).rejects.toThrow(/already belongs to a creator/);
    expect(calls).toHaveLength(0);
    expect(existsSync(out)).toBe(false);
  });

  test("a committed synthetic handle is refused", async () => {
    const { deps, calls } = setup();
    await expect(initDraft(draftOf(exportFor("junovale")), deps)).rejects.toThrow(/synthetic/);
    expect(calls).toHaveLength(0);
  });

  test("the email of a fan or an admin is refused; so is one that already runs another creator", async () => {
    const { deps, calls } = setup();
    for (const role of ["fan", "admin"] as const) {
      const holder = await makeUser({ role });
      await expect(initDraft(draftOf(exportFor(newHandle()), { email: holder.email!.toUpperCase() }), deps)).rejects.toThrow(/fan or admin/);
    }
    const creatorUser = await makeUser({ role: "creator" });
    await db.insert(creators).values({ userId: creatorUser.id, handle: newHandle(), displayName: "Other" });
    await expect(initDraft(draftOf(exportFor(newHandle()), { email: creatorUser.email! }), deps)).rejects.toThrow(/already belongs to the creator/);
    expect(calls).toHaveLength(0);
  });

  test("a different --handle on an export is refused before anything is written", async () => {
    const { deps, calls } = setup();
    const out = path.join(tmp("out"), "bank");
    const handle = newHandle();
    await expect(initDraft(draftOf(exportFor(handle), { out, handle: "somebody.else" }), deps)).rejects.toBeInstanceOf(NotOwnAccount);
    expect(calls).toHaveLength(0);
    expect(existsSync(out)).toBe(false);
  });

  test("a missing key, a non-empty --out and an --out inside the repository are refused before a model call", async () => {
    const { deps, calls } = setup();
    const input = exportFor(newHandle());
    await expect(initDraft(draftOf(input), { ...deps, env: {} })).rejects.toThrow(/CLAUDE_SECRET_KEY/);
    const busy = tmp("busy");
    writeFileSync(path.join(busy, "something"), "x");
    await expect(initDraft(draftOf(input, { out: busy }), deps)).rejects.toThrow(/not empty/);
    await expect(initDraft(draftOf(input, { out: path.resolve(import.meta.dirname, "inside-the-repo") }), deps)).rejects.toThrow(/outside this repository/);
    expect(calls).toHaveLength(0);
  });

  test("--scrape-own with another --handle is refused, nothing written", async () => {
    const requests: { url: string }[] = [];
    const { deps, calls } = setup();
    const out = path.join(tmp("out"), "bank");
    const opts = { kind: "draft" as const, source: { kind: "scrape" as const }, email: newEmail(), cardModel: "m", handle: "somebody.else", out };
    await expect(initDraft(opts, { ...deps, fetch: fixtureFetch({ log: requests }) })).rejects.toBeInstanceOf(NotOwnAccount);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain("current_user");
    expect(calls).toHaveLength(0);
    expect(existsSync(out)).toBe(false);
  });

  test("--scrape-own drafts the session's account", async () => {
    const { deps, calls } = setup();
    const out = path.join(tmp("out"), "bank");
    const email = newEmail();
    const opts = { kind: "draft" as const, source: { kind: "scrape" as const }, email, cardModel: "m", out };
    const drafted = await initDraft(opts, { ...deps, fetch: fixtureFetch() });
    expect(drafted.handle).toBe("fixturecreator");
    expect(calls).toHaveLength(1);
    expect(existsSync(path.join(out, "raw", "fixturecreator", "posts.jsonl"))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(out, "init.json"), "utf8"))).toMatchObject({ source: "scrape-own", handle: "fixturecreator", display_name: "Fixture Creator", email });
    expect(readFileSync(path.join(out, "card", "v1.md"), "utf8")).toContain("## Selling voice");
    // The cookie is never written anywhere in the output.
    for (const file of filesUnder(out)) expect(readFileSync(path.join(out, file), "utf8")).not.toContain(ENV.IG_SESSIONID);
  });

  test("no Voyage key: the chunks are stored with null embeddings and the log says so", async () => {
    const { deps, lines } = setup();
    const drafted = await initDraft(draftOf(exportFor(newHandle())), deps);
    const published = await initPublish(drafted.out, { ...deps, embedDocuments: null });
    const rows = await db.select().from(personaChunks).where(eq(personaChunks.creatorId, published.creatorId));
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.embedding === null)).toBe(true);
    expect(lines.some((line) => line.includes("no embeddings"))).toBe(true);
  });

  test("under 30 marker texts the published card stores no markers; at 30 or more it does", async () => {
    const { deps } = setup();
    const few = await initDraft(draftOf(exportFor(newHandle())), deps);
    const fewPublished = await initPublish(few.out, deps);
    expect((await cardsOf(fewPublished.creatorId))[0].markers).toBeNull();

    const many = await initDraft(draftOf(exportFor(newHandle(), MIN_MARKER_TEXTS + 2)), deps);
    const manyPublished = await initPublish(many.out, deps);
    const [card] = await cardsOf(manyPublished.creatorId);
    expect(card.markers).toMatchObject({ n: expect.any(Number) });
    expect((card.markers as { n: number }).n).toBeGreaterThanOrEqual(MIN_MARKER_TEXTS);
  });

  test("an edited card that lost a section is refused before any write", async () => {
    const email = newEmail();
    const handle = newHandle();
    const { deps } = setup();
    const drafted = await initDraft(draftOf(exportFor(handle), { email }), deps);
    editCard(drafted.out, (card) => card.replace(/## Never\n[\s\S]*?(?=## Selling voice)/, ""));
    await expect(initPublish(drafted.out, deps)).rejects.toThrow(/lost section\(s\): Never/);
    expect(await userRows(email)).toHaveLength(0);
    expect(await creatorRows(handle)).toHaveLength(0);
    // Sections out of order are refused too.
    const reordered = await initDraft(draftOf(exportFor(newHandle())), deps);
    editCard(reordered.out, (card) => {
      const [head, rest] = [card.slice(0, card.indexOf("## Voice rules")), card.slice(card.indexOf("## Voice rules"))];
      const identity = head.trimEnd();
      return `${rest.trimEnd()}\n${identity}\n`;
    });
    await expect(initPublish(reordered.out, deps)).rejects.toThrow(/sections must be, in order/);
  });

  test("a handle taken between the phases is refused and leaves no user behind", async () => {
    const handle = newHandle();
    const email = newEmail();
    const { deps } = setup();
    const drafted = await initDraft(draftOf(exportFor(handle), { email }), deps);
    const other = await makeUser({ role: "creator" });
    await db.insert(creators).values({ userId: other.id, handle, displayName: "Other" });
    await expect(initPublish(drafted.out, deps)).rejects.toThrow(/belongs to another user/);
    expect(await userRows(email)).toHaveLength(0);
  });
});

describe("ensureCreator", () => {
  test("creates the user and the creator once, and finds them again", async () => {
    const email = newEmail();
    const handle = newHandle();
    const first = await db.transaction((tx) => ensureCreator(tx, { email: email.toUpperCase(), handle, displayName: "Wren" }));
    const second = await db.transaction((tx) => ensureCreator(tx, { email, handle, displayName: "Wren" }));
    expect(second).toEqual(first);
    expect(await userRows(email)).toHaveLength(1);
    expect(await creatorRows(handle)).toHaveLength(1);
  });

  test("two transactions at once share one user and one creator", async () => {
    const input = { email: newEmail(), handle: newHandle(), displayName: "Wren" };
    let release!: () => void;
    let ensured!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const firstDone = new Promise<void>((resolve) => (ensured = resolve));
    const first = db.transaction(async (tx) => {
      const made = await ensureCreator(tx, input);
      ensured();
      await gate;
      return made;
    });
    await firstDone;
    // The first transaction has inserted both rows and not committed: the second waits on them.
    let secondFinished = false;
    const second = db.transaction((tx) => ensureCreator(tx, input)).then((made) => ((secondFinished = true), made));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(secondFinished).toBe(false);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(b).toEqual(a);
    expect(await userRows(input.email)).toHaveLength(1);
    expect(await creatorRows(input.handle)).toHaveLength(1);
  });

  test("refuses a user who is not a creator and a user who already runs another handle", async () => {
    const fan = await makeUser({ role: "fan" });
    await expect(db.transaction((tx) => ensureCreator(tx, { email: fan.email!, handle: newHandle(), displayName: "x" }))).rejects.toThrow(/fan or admin/);
    expect((await db.select().from(users).where(eq(users.id, fan.id)))[0].role).toBe("fan");

    const email = newEmail();
    await db.transaction((tx) => ensureCreator(tx, { email, handle: newHandle(), displayName: "First" }));
    await expect(db.transaction((tx) => ensureCreator(tx, { email, handle: newHandle(), displayName: "Second" }))).rejects.toThrow(/another handle/);
  });
});

describe("a creator made by init in the engine", () => {
  test("before publish the engine fails closed; after it, a creator with an empty catalogue gets words and no offer", async () => {
    await setEngineConfig({ "pitch.min_gap_rounds": 0, "engine.debounce_ms": 0 });
    const { deps } = setup();
    const drafted = await initDraft(draftOf(exportFor(newHandle())), deps);

    // Created and loaded but not published: the card waits, so the turn cannot run.
    const { creatorId } = await db.transaction((tx) => {
      const state = JSON.parse(readFileSync(path.join(drafted.out, "init.json"), "utf8")) as { email: string; handle: string; display_name: string };
      return ensureCreator(tx, { email: state.email, handle: state.handle, displayName: state.display_name });
    });
    await loadPersona({ creatorId, dir: drafted.out, embedDocuments: null });
    const fan = await makeFan();
    const conv = await makeConversation(creatorId, fan.id);
    await addMessage(conv.id, "fan", "hey, how are you?", { ageSeconds: 5 });
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(await rig({ script: { offer_pick: "o1" } }).chatter.processConversation(conv.id)).toBe(0);
    } finally {
      console.error = quiet;
    }
    const turnsOf = () => db.select().from(turns).where(eq(turns.conversationId, conv.id)).orderBy(asc(turns.createdAt));
    expect((await turnsOf()).map((t) => t.outcome)).toEqual(["error"]);
    expect(await db.select().from(messages).where(and(eq(messages.conversationId, conv.id), eq(messages.sender, "ai")))).toHaveLength(0);

    await initPublish(drafted.out, deps);
    expect(await rig({ script: { offer_pick: "o1" } }).chatter.processConversation(conv.id)).toBe(1);
    const turn = (await turnsOf()).at(-1)!;
    expect(turn).toMatchObject({ route: "reply", outcome: "replied", offerId: null });
    expect(await db.select().from(offers).where(eq(offers.conversationId, conv.id))).toHaveLength(0);
  });

  test("the same creator with one catalogue item is offered it, so the empty-catalogue reply is not a quirk of the setup", async () => {
    await setEngineConfig({ "pitch.min_gap_rounds": 0, "engine.debounce_ms": 0 });
    const { deps } = setup();
    const drafted = await initDraft(draftOf(exportFor(newHandle())), deps);
    const { creatorId } = await initPublish(drafted.out, deps);
    const item = await makeItem(creatorId, { title: "Pier at dawn", priceCents: 1500 });
    const fan = await makeFan();
    const conv = await makeConversation(creatorId, fan.id);
    await addMessage(conv.id, "fan", "hey, how are you?", { ageSeconds: 5 });
    expect(await rig({ script: { offer_pick: "o1", pitch_fit: YES } }).chatter.processConversation(conv.id)).toBe(1);
    const [offer] = await db.select().from(offers).where(eq(offers.conversationId, conv.id));
    expect(offer).toMatchObject({ itemId: item.id, priceCents: 1500 });
  });
});
