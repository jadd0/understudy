import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { config, fanMemory, ledgerEntries, personaChunks, unlocks } from "@/db/schema";
import { listInbox } from "@/lib/conversations/read";
import { loadEngineConfig } from "./cfg";
import { loadProfile } from "./memory";
import { buildShortlist } from "./offer";
import { retrieveFts, retrieveVector, type RetrieveDeps } from "./retrieve";
import { runTurn } from "./turn";
import { takeOver } from "./takeover";
import { addMessage, makeConversation, makeCreator, makeFan, makeItem, makePersona, setEngineConfig } from "./test-db";
import { isMemoryCall, rig } from "./test-harness";

const hot = (n: number) => Array.from({ length: 1024 }, (_, i) => (i === n ? 1 : 0));
const tag = randomUUID().slice(0, 8).replace(/-/g, "");

/** Two creators, each with a published card, chunks, items and a conversation with the same fan. */
async function twoCreators() {
  await setEngineConfig();
  const fan = await makeFan();
  const make = async (name: string) => {
    const creator = await makeCreator();
    const card = await makePersona(creator.id, `You are ${name}. Lowercase and warm, signature ${name}${tag}.`);
    const item = await makeItem(creator.id, { title: `${name} item`, teaser: `${name} teaser` });
    const conv = await makeConversation(creator.id, fan.id);
    const chunk = await db
      .insert(personaChunks)
      .values({ creatorId: creator.id, source: "caption", text: `${name}${tag} wrote about the lighthouse${tag}`, meta: { chunk_id: `${name}-c` }, embedding: hot(name === "alpha" ? 0 : 1) })
      .returning();
    return { creator, card, item, conv, chunk: chunk[0] };
  };
  return { fan, a: await make("alpha"), b: await make("bravo") };
}

const replyOf = async (w: Awaited<ReturnType<typeof twoCreators>>["a"], text: string) => {
  const r = rig();
  await addMessage(w.conv.id, "fan", text, { ageSeconds: 5 });
  await runTurn(r.ctx, w.conv.id);
  const call = r.generator.calls.find((c) => !isMemoryCall(c));
  if (!call) throw new Error("the turn made no generate call");
  return call;
};

describe("two creators side by side", () => {
  test("a turn for A retrieves only A's chunks (full text)", async () => {
    const w = await twoCreators();
    const call = await replyOf(w.a, `tell me about the lighthouse${tag}`);
    expect(call.system.turn).toContain(`alpha${tag} wrote about`);
    expect(call.system.turn).not.toContain(`bravo${tag}`);
  });

  test("vector retrieval for A returns only A's chunks, even when B's is the nearer vector", async () => {
    const w = await twoCreators();
    const deps: RetrieveDeps = { db, embedQuery: async () => hot(1) };
    const hits = await retrieveVector(w.a.creator.id, "anything", 10, deps);
    expect(hits.map((h) => h.chunkId)).toEqual(["alpha-c"]);
    expect((await retrieveVector(w.b.creator.id, "anything", 10, deps)).map((h) => h.chunkId)).toEqual(["bravo-c"]);
  });

  test("a chunk of B's that carries A's id in its text is not returned for A", async () => {
    const w = await twoCreators();
    const needle = `needle${tag}`;
    await db.insert(personaChunks).values({ creatorId: w.b.creator.id, source: "caption", text: `${needle} ${w.a.creator.id}`, meta: { chunk_id: "planted" } });
    const hits = await retrieveFts(w.a.creator.id, needle, 10, { db, embedQuery: async () => hot(0) });
    expect(hits).toEqual([]);
    expect((await retrieveFts(w.b.creator.id, needle, 10, { db, embedQuery: async () => hot(0) })).map((h) => h.chunkId)).toEqual(["planted"]);
  });

  test("a turn for A reads A's published card, never B's", async () => {
    const w = await twoCreators();
    const call = await replyOf(w.a, "hey, how are you?");
    expect(call.system.cached).toContain(`alpha${tag}`);
    expect(call.system.cached).not.toContain(`bravo${tag}`);
  });

  test("A's creator config override reaches A's turn and not B's", async () => {
    const w = await twoCreators();
    await db.insert(config).values({ key: "engine.max_tokens", value: 123, creatorId: w.a.creator.id });
    const rA = rig();
    expect((await loadEngineConfig(rA.ctx, w.a.creator.id)).maxTokens).toBe(123);
    const cfgB = await loadEngineConfig(rA.ctx, w.b.creator.id);
    expect(cfgB.maxTokens).not.toBe(123);
    expect((await replyOf(w.a, "hey")).maxTokens).toBe(123);
    expect((await replyOf(w.b, "hey")).maxTokens).toBe(cfgB.maxTokens);
  });

  test("a creator row under a platform-only key is ignored for the creator that holds it and for the other", async () => {
    const w = await twoCreators();
    await db.insert(config).values({ key: "floor.intent", value: 0.01, creatorId: w.b.creator.id });
    const r = rig();
    const [platform, forA, forB] = await Promise.all([
      loadEngineConfig(r.ctx, (await makeCreator()).id),
      loadEngineConfig(r.ctx, w.a.creator.id),
      loadEngineConfig(r.ctx, w.b.creator.id),
    ]);
    expect(platform.route.floors.intent).toBe(0.5);
    expect(forA.route.floors.intent).toBe(0.5);
    expect(forB.route.floors.intent).toBe(0.5);
  });

  test("A's shortlist never contains B's items, even for a fan who owns B's items", async () => {
    const w = await twoCreators();
    const [entry] = await db
      .insert(ledgerEntries)
      .values({ fanId: w.fan.id, creatorId: w.b.creator.id, kind: "unlock", amountCents: -999, conversationId: w.b.conv.id })
      .returning();
    await db.insert(unlocks).values({ fanId: w.fan.id, itemId: w.b.item.id, ledgerEntryId: entry.id });
    const { ctx } = rig();
    const shortlistA = await buildShortlist(ctx.host, w.a.creator.id, w.fan.id, w.a.conv.id);
    expect(shortlistA.length).toBeGreaterThan(0);
    expect(shortlistA.map((i) => i.title)).toEqual(["alpha item"]);
    expect(await buildShortlist(ctx.host, w.b.creator.id, w.fan.id, w.b.conv.id)).toEqual([]);
  });

  test("fan memory for the same fan is separate per creator", async () => {
    const w = await twoCreators();
    await db.insert(fanMemory).values([
      { creatorId: w.a.creator.id, fanId: w.fan.id, profile: { name: "Sam", interests: ["climbing"], dislikes: [] } },
      { creatorId: w.b.creator.id, fanId: w.fan.id, profile: { name: "Samuel", interests: ["chess"], dislikes: [] } },
    ]);
    const { ctx } = rig();
    expect(await loadProfile(ctx, w.a.creator.id, w.fan.id)).toMatchObject({ name: "Sam", interests: ["climbing"] });
    expect(await loadProfile(ctx, w.b.creator.id, w.fan.id)).toMatchObject({ name: "Samuel", interests: ["chess"] });
  });

  test("A's inbox lists only A's conversations; A's actor cannot take over B's", async () => {
    const w = await twoCreators();
    const inboxA = await listInbox({ id: w.a.creator.userId, role: "creator" });
    expect(inboxA.map((r) => r.id)).toEqual([w.a.conv.id]);
    await expect(takeOver({ db }, w.b.conv.id, { id: randomUUID(), side: "creator", creatorId: w.a.creator.id })).rejects.toMatchObject({ code: "not_allowed" });
    expect((await db.execute(sql`select mode from conversations where id = ${w.b.conv.id}`)).rows[0]).toMatchObject({ mode: "ai" });
  });
});

describe("every table with a creator dimension carries it", () => {
  // Tables that hold a creator's data carry creator_id, or hang off a conversation or a user. A new table lands in
  // none of these sets until it is classified here, which fails this test.
  const CREATOR_ID = ["catalogue_items", "config", "conversations", "creator_settings", "fan_memory", "ledger_entries", "persona_cards", "persona_chunks", "sim_runs"];
  const VIA_CONVERSATION = ["handoffs", "messages", "offers", "turns"];
  const VIA_ITEM = ["unlocks"];
  // sim_lines is the shared bank of simulator lines, not any creator's data.
  const NOT_CREATOR_DATA = ["accounts", "creators", "sessions", "sim_lines", "uncredited_payments", "users", "verification_tokens", "wallets"];

  test("the schema's tables are exactly the classified ones, and each set holds its claim", async () => {
    const tables = (await db.execute(sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name not like '\\_\\_%' and table_name not like 'drizzle%'`)).rows.map((r) => String(r.table_name)).sort();
    expect(tables).toEqual([...CREATOR_ID, ...VIA_CONVERSATION, ...VIA_ITEM, ...NOT_CREATOR_DATA].sort());

    const withCreator = new Set((await db.execute(sql`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'creator_id'`)).rows.map((r) => String(r.table_name)));
    for (const t of CREATOR_ID) expect(withCreator.has(t), `${t} has creator_id`).toBe(true);

    const fk = async (table: string, target: string) =>
      (await db.execute(sql`select 1 from pg_constraint where contype = 'f' and conrelid = ${`public.${table}`}::regclass and confrelid = ${`public.${target}`}::regclass`)).rows.length > 0;
    for (const t of VIA_CONVERSATION) expect(await fk(t, "conversations"), `${t} reaches conversations`).toBe(true);
    expect(await fk("unlocks", "catalogue_items")).toBe(true);
  });
});

