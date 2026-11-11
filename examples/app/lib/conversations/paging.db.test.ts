import { eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db, withTx } from "@/db/client";
import { messages, offers } from "@/db/schema";
import { seedChat } from "@jadd0/understudy-engine/testing";
import { makeItem, makeOffer } from "@/lib/wallet/test-helpers";
import { BadCursor, decodeSync, encodeOlder, encodeSync } from "./cursor";
import { getChanges, getOlderMessages, getWindowedSnapshot } from "./paging";
import { ConversationNotFound, getSnapshot, getThread } from "./read";
import { addMessage, asViewer, makeAdmin, makeConversation, makeCreator, makeFan } from "./test-helpers";
import { MESSAGE_PAGE_SIZE } from "./window";

/**
 * `n` fan/AI bubbles `secondsApart` apart, the newest `endAgoSeconds` old. Every fifth pair shares one created_at, so
 * the (sort_at, id) keyset has ties to break by id.
 */
async function seed(conversationId: string, n: number, endAgoSeconds = 60) {
  const rows = Array.from({ length: n }, (_, i) => {
    const slot = Math.floor(i / 5) * 5 === i ? i + 1 : i; // i and i+1 share a slot when i is a multiple of 5
    return {
      conversationId,
      sender: (i % 2 ? "ai" : "fan") as "ai" | "fan",
      body: `m${i}`,
      createdAt: sql`now() - make_interval(secs => ${endAgoSeconds + (n - slot)})` as unknown as Date,
    };
  });
  await db.insert(messages).values(rows);
  return n;
}

/**
 * Moves `updated_at` back by `ago` for the matching rows of `table`, with its trigger off for that one transaction,
 * so a test can make a row look untouched since long before a cursor.
 */
async function backdate(table: "messages" | "offers", where: ReturnType<typeof sql>, ago = "10 minutes") {
  await withTx(async (tx) => {
    await tx.execute(sql`alter table ${sql.raw(table)} disable trigger ${sql.raw(`${table}_set_updated_at`)}`);
    await tx.execute(sql`update ${sql.raw(table)} set updated_at = now() - ${ago}::interval where ${where}`);
    await tx.execute(sql`alter table ${sql.raw(table)} enable trigger ${sql.raw(`${table}_set_updated_at`)}`);
  });
}

async function world() {
  const creator = await makeCreator();
  const fan = await makeFan();
  const other = await makeFan();
  const conv = await makeConversation(creator.id, fan.id);
  const otherConv = await makeConversation(creator.id, other.id);
  return {
    creator,
    creatorViewer: asViewer({ id: creator.userId, role: "creator" }),
    fan: asViewer({ id: fan.id, role: "fan" }),
    other: asViewer({ id: other.id, role: "fan" }),
    conv,
    otherConv,
  };
}

describe("paging", () => {
  test("first load is the newest page; older pages walk back with no gaps or duplicates while new messages arrive", async () => {
    const w = await world();
    await seed(w.conv.id, 40);
    const all = (await getThread(w.fan, w.conv.id)).messages.map((m) => m.id);
    expect(all).toHaveLength(40);

    const first = await getWindowedSnapshot(w.fan, w.conv.id);
    expect(first.thread.messages.map((m) => m.id)).toEqual(all.slice(-MESSAGE_PAGE_SIZE));
    expect(first.window.olderCursor).not.toBeNull();
    expect(decodeSync(first.window.syncCursor)).toMatch(/Z$/);

    const seen = [...first.thread.messages.map((m) => m.id)];
    let cursor = first.window.olderCursor;
    let pages = 0;
    while (cursor) {
      // New messages land between every page; they must not shift or repeat the older pages.
      await addMessage(w.conv.id, "fan", `late ${pages}`);
      const page = await getOlderMessages(w.fan, w.conv.id, cursor);
      expect(page.messages.length).toBeGreaterThan(0);
      expect(page.labels).toEqual({});
      seen.unshift(...page.messages.map((m) => m.id));
      cursor = page.olderCursor;
      pages++;
    }
    expect(pages).toBe(2);
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(40);
  });

  test("a short thread has no older cursor, and the windowed page keeps the fan's visibility rules", async () => {
    const w = await world();
    await addMessage(w.conv.id, "fan", "hi", { ageSeconds: 30 });
    await addMessage(w.conv.id, "ai", "held draft", { status: "blocked" });
    await db.update(messages).set({ suggested: true }).where(eq(messages.body, "held draft"));
    await addMessage(w.conv.id, "ai", "retired", { status: "superseded" });
    const due = await addMessage(w.conv.id, "ai", "later");
    await db.update(messages).set({ deliverAt: sql`now() + interval '1 hour'` }).where(eq(messages.id, due.id));
    const snap = await getWindowedSnapshot(w.fan, w.conv.id);
    expect(snap.thread.messages.map((m) => m.body)).toEqual(["hi"]);
    expect(snap.window.olderCursor).toBeNull();
    expect(snap.thread.pendingMs).toHaveLength(1);
    const staff = await getWindowedSnapshot(w.creatorViewer, w.conv.id);
    expect(staff.suggested?.body).toBe("held draft");
  });
});

describe("changes", () => {
  test("new rows, an updated offer state and a bubble that became due appear; nothing else does", async () => {
    const w = await world();
    await seed(w.conv.id, 20, 600);
    const item = await makeItem(w.creator.id, 999);
    const offer = await makeOffer(w.conv.id, item.id, 999);
    const [carrier] = await db
      .insert(messages)
      .values({ conversationId: w.conv.id, sender: "ai", body: "want it?", offerId: offer.id, createdAt: sql`now() - interval '10 minutes'` as unknown as Date })
      .returning();
    const due = await addMessage(w.conv.id, "ai", "soon");
    await db.update(messages).set({ deliverAt: sql`now() + interval '5 seconds'` }).where(eq(messages.id, due.id));
    const dueAt = Date.now() + 5000;
    // Back-date every stamp so the first change read sees nothing old.
    await backdate("messages", sql`conversation_id = ${w.conv.id}`);
    await backdate("offers", sql`id = ${offer.id}`);

    const start = await getWindowedSnapshot(w.fan, w.conv.id);
    expect(start.thread.messages.find((m) => m.id === carrier.id)?.offer?.state).toBe("locked");
    const quiet = await getChanges(w.fan, w.conv.id, start.window.syncCursor);
    expect(quiet.upserts.map((m) => m.id)).toEqual([]);
    expect(quiet.thread.pendingMs).toHaveLength(1);

    await new Promise((r) => setTimeout(r, Math.max(0, dueAt - Date.now()) + 300));
    await db.update(offers).set({ status: "accepted" }).where(eq(offers.id, offer.id));
    const fresh = await addMessage(w.conv.id, "fan", "new one");
    const ch = await getChanges(w.fan, w.conv.id, quiet.syncCursor);
    const byId = new Map(ch.upserts.map((m) => [m.id, m]));
    expect(byId.get(carrier.id)?.offer?.state).toBe("unlocked");
    expect(byId.has(due.id)).toBe(true);
    expect(byId.has(fresh.id)).toBe(true);
    expect(ch.upserts).toHaveLength(3);
    expect(ch.thread.pendingMs).toEqual([]);
    // Oldest first, in thread order.
    const order = (await getThread(w.fan, w.conv.id)).messages.map((m) => m.id).filter((id) => byId.has(id));
    expect(ch.upserts.map((m) => m.id)).toEqual(order);
  });

  test("the overlap re-reads recent rows, each once per read, and an expiry with no write shows", async () => {
    const w = await world();
    const a = await addMessage(w.conv.id, "fan", "a", { ageSeconds: 30 });
    await db.update(messages).set({ body: "a, edited" }).where(eq(messages.id, a.id));
    const snap = await getWindowedSnapshot(w.fan, w.conv.id);
    // The row is inside the overlap of the snapshot's own cursor: read again, once, though it matches two branches.
    const ch = await getChanges(w.fan, w.conv.id, snap.window.syncCursor);
    expect(ch.upserts.map((m) => m.id)).toEqual([a.id]);

    const item = await makeItem(w.creator.id, 500);
    // A wall-clock expiry a second out raced the setup's round trips on a slow database: the offer could expire
    // before the first read. It is live for the setup and is expired below, after that read.
    const offer = await makeOffer(w.conv.id, item.id, 500, { expiresInSeconds: 3600 });
    const [carrier] = await db
      .insert(messages)
      .values({ conversationId: w.conv.id, sender: "ai", body: "quick", offerId: offer.id, createdAt: sql`now() - interval '10 minutes'` as unknown as Date })
      .returning();
    await backdate("messages", sql`conversation_id = ${w.conv.id}`);
    await backdate("offers", sql`id = ${offer.id}`);
    const before = await getChanges(w.fan, w.conv.id, ch.syncCursor);
    expect(before.upserts).toEqual([]);
    // The expiry passes now with the updated_at trigger off, so no write the change read could see is left behind.
    await withTx(async (tx) => {
      await tx.execute(sql`alter table offers disable trigger offers_set_updated_at`);
      await tx.execute(sql`update offers set expires_at = now() where id = ${offer.id}`);
      await tx.execute(sql`alter table offers enable trigger offers_set_updated_at`);
    });
    // Nothing wrote the offer or the bubble; its expiry passing is the change.
    const later = await getChanges(w.fan, w.conv.id, before.syncCursor);
    expect(later.upserts.map((m) => [m.id, m.offer?.state])).toEqual([[carrier.id, "expired"]]);
  });

  test("staff changes carry the waiting suggestion and only the upserted bubbles' labels", async () => {
    const w = await world();
    const admin = asViewer(await makeAdmin());
    const snap = await getWindowedSnapshot(admin, w.conv.id);
    await addMessage(w.conv.id, "ai", "draft", { status: "blocked" });
    await db.update(messages).set({ suggested: true }).where(eq(messages.conversationId, w.conv.id));
    const ch = await getChanges(admin, w.conv.id, snap.window.syncCursor);
    expect(ch.suggested?.body).toBe("draft");
    expect(ch.upserts).toEqual([]);
    expect(ch.labels).toEqual({});
  });
});

describe("labels", () => {
  test("staff get the same labels as the whole snapshot, for the bubbles returned; a fan gets none", async () => {
    const w = await world();
    const lines = await seedChat(w.conv.id, [
      { sender: "fan", body: "hey", minutesAgo: 3 },
      { sender: "ai", body: "hi you", minutesAgo: 2 },
    ]);
    const whole = await getSnapshot(w.creatorViewer, w.conv.id);
    expect(Object.keys(whole.labels)).toEqual([lines[1].id]);
    expect((await getWindowedSnapshot(w.creatorViewer, w.conv.id)).labels).toEqual(whole.labels);
    expect((await getWindowedSnapshot(w.fan, w.conv.id)).labels).toEqual({});
  });
});

describe("scope and cursors", () => {
  test("a fan cannot page or read changes in another fan's conversation, even with that conversation's cursor", async () => {
    const w = await world();
    await seed(w.otherConv.id, 30);
    await seed(w.conv.id, 30);
    const theirs = await getWindowedSnapshot(w.other, w.otherConv.id);
    await expect(getWindowedSnapshot(w.fan, w.otherConv.id)).rejects.toBeInstanceOf(ConversationNotFound);
    await expect(getOlderMessages(w.fan, w.otherConv.id, theirs.window.olderCursor)).rejects.toBeInstanceOf(ConversationNotFound);
    await expect(getChanges(w.fan, w.otherConv.id, theirs.window.syncCursor)).rejects.toBeInstanceOf(ConversationNotFound);
    // Their older cursor in his own conversation is refused, not read against his rows.
    await expect(getOlderMessages(w.fan, w.conv.id, theirs.window.olderCursor)).rejects.toBeInstanceOf(BadCursor);
    // Another creator cannot read either; an admin can.
    const stranger = await makeCreator();
    await expect(getChanges(asViewer({ id: stranger.userId, role: "creator" }), w.conv.id, theirs.window.syncCursor)).rejects.toBeInstanceOf(
      ConversationNotFound,
    );
    const admin = asViewer(await makeAdmin());
    expect((await getOlderMessages(admin, w.otherConv.id, theirs.window.olderCursor)).messages).toHaveLength(MESSAGE_PAGE_SIZE);
  });

  test("a malformed cursor or conversation id is refused before any SQL runs", async () => {
    const w = await world();
    const bad = [
      undefined,
      42,
      "",
      "not base64!",
      Buffer.from("not json").toString("base64url"),
      Buffer.from(JSON.stringify({ k: "older", c: w.conv.id, t: "2026-02-30T00:00:00.000000Z", id: w.conv.id })).toString("base64url"),
      Buffer.from(JSON.stringify({ k: "older", c: w.conv.id, t: "x'; drop table messages; --", id: w.conv.id })).toString("base64url"),
      encodeSync("2026-11-04T00:00:00.000000Z"),
      "a".repeat(600),
    ];
    for (const c of bad) await expect(getOlderMessages(w.fan, w.conv.id, c)).rejects.toBeInstanceOf(BadCursor);
    await expect(getChanges(w.fan, w.conv.id, encodeOlder({ conversationId: w.conv.id, sortAt: "2026-11-04T00:00:00.000000Z", id: w.conv.id }))).rejects.toBeInstanceOf(
      BadCursor,
    );
    await expect(getChanges(w.fan, "not-a-uuid", encodeSync("2026-11-04T00:00:00.000000Z"))).rejects.toBeInstanceOf(ConversationNotFound);
  });
});

describe("schema", () => {
  test("the migration added sort_at as coalesce(deliver_at, created_at) and an update bumps updated_at", async () => {
    const w = await world();
    const m = await addMessage(w.conv.id, "ai", "x", { ageSeconds: 100 });
    const [before] = await db.select().from(messages).where(eq(messages.id, m.id));
    expect(before.sortAt?.getTime()).toBe(before.createdAt.getTime());
    await backdate("messages", sql`id = ${m.id}`, "1 hour");
    const [old] = await db.select().from(messages).where(eq(messages.id, m.id));
    await db.update(messages).set({ deliverAt: sql`now() + interval '5 minutes'` }).where(eq(messages.id, m.id));
    const [after] = await db.select().from(messages).where(eq(messages.id, m.id));
    expect(after.updatedAt.getTime()).toBeGreaterThan(old.updatedAt.getTime() + 3_000_000);
    expect(after.sortAt?.getTime()).toBe(after.deliverAt?.getTime());

    const idx = await db.execute(sql`select indexname from pg_indexes where tablename = 'messages' and indexname in ('messages_conversation_sort_idx', 'messages_conversation_updated_idx')`);
    expect(idx.rows).toHaveLength(2);
  });
});
