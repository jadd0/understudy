import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { messages, users } from "@/db/schema";
import { ConversationNotFound, getSuggested, getThread, listInbox, toThreadMessage } from "./read";
import { addFuture, addMessage, asViewer, makeAdmin, makeConversation, makeCreator, makeCreatorHandoff, makeFan, moveToTs, setMode } from "./test-helpers";

async function world() {
  const creator = await makeCreator();
  const creatorUser = asViewer({ id: creator.userId, role: "creator" });
  const fanA = await makeFan();
  const fanB = await makeFan();
  const normal = await makeConversation(creator.id, fanA.id);
  const risky = await makeConversation(creator.id, fanB.id);
  await addMessage(normal.id, "fan", "hello there", { ageSeconds: 10 });
  await addMessage(risky.id, "fan", "something worrying", { ageSeconds: 10 });
  return { creator, creatorUser, fanA, fanB, normal, risky };
}

describe("viewer scoping", () => {
  test("creator_never_lists_ts_conversation", async () => {
    for (const status of ["open", "claimed"] as const) {
      const w = await world();
      const h = await moveToTs(w.risky.id, status);
      const ids = (await listInbox(w.creatorUser)).map((r) => r.id);
      // not vacuous: her own other conversation is listed, and the admin can read the one she cannot
      expect(ids).toEqual([w.normal.id]);
      const admin = asViewer(await makeAdmin());
      expect((await listInbox(admin)).map((r) => r.id)).toContain(w.risky.id);
      expect(h.queue).toBe("ts");
    }
  });

  test("creator_getThread_on_ts_conversation_throws_not_found", async () => {
    const w = await world();
    await moveToTs(w.risky.id);
    await expect(getThread(w.creatorUser, w.risky.id)).rejects.toBeInstanceOf(ConversationNotFound);
    await expect(getSuggested(w.creatorUser, w.risky.id)).rejects.toBeInstanceOf(ConversationNotFound);
    expect((await getThread(w.creatorUser, w.normal.id)).messages.map((m) => m.body)).toEqual(["hello there"]);
    const admin = asViewer(await makeAdmin());
    expect((await getThread(admin, w.risky.id)).messages.map((m) => m.body)).toEqual(["something worrying"]);
    // another creator never sees her fans either
    const other = await makeCreator();
    await expect(getThread(asViewer({ id: other.userId, role: "creator" }), w.normal.id)).rejects.toBeInstanceOf(ConversationNotFound);
  });

  test("admin_lists_every_conversation_with_ts_first", async () => {
    const w = await world();
    await moveToTs(w.risky.id);
    const admin = asViewer(await makeAdmin());
    const ids = (await listInbox(admin)).map((r) => r.id);
    expect(ids).toContain(w.normal.id);
    expect(ids.indexOf(w.risky.id)).toBeLessThan(ids.indexOf(w.normal.id));
    expect((await getThread(admin, w.normal.id)).conversation.id).toBe(w.normal.id);
  });


  test("a fan reads only their own conversation and cannot list an inbox", async () => {
    const w = await world();
    expect((await getThread(asViewer({ id: w.fanA.id, role: "fan" }), w.normal.id)).conversation.id).toBe(w.normal.id);
    await expect(getThread(asViewer({ id: w.fanA.id, role: "fan" }), w.risky.id)).rejects.toBeInstanceOf(ConversationNotFound);
    await expect(listInbox(asViewer({ id: w.fanA.id, role: "fan" }))).rejects.toBeInstanceOf(ConversationNotFound);
  });
});

describe("what a fan may see", () => {
  test("fan_thread_hides_suggested_superseded_and_future_deliver_at", async () => {
    const w = await world();
    await addMessage(w.normal.id, "ai", "visible reply", { ageSeconds: 1 });
    await addMessage(w.normal.id, "ai", "retired reply", { status: "superseded" });
    const held = await addMessage(w.normal.id, "ai", "held draft", { status: "blocked" });
    await db.update(messages).set({ suggested: true }).where(eq(messages.id, held.id));
    await addFuture(w.normal.id, "ai", "not due yet", 30);

    const fan = asViewer({ id: w.fanA.id, role: "fan" });
    const t = await getThread(fan, w.normal.id);
    expect(t.messages.map((m) => m.body)).toEqual(["hello there", "visible reply"]);
    // no text leaks, but the page learns a bubble is on its way
    expect(t.pendingMs).toHaveLength(1);
    expect(t.pendingMs[0]).toBeGreaterThan(20_000);
    expect(JSON.stringify(t)).not.toContain("not due yet");
    expect(JSON.stringify(t)).not.toContain("held draft");
    expect(t.handoff).toBeNull();

    // the creator sees the same bubbles plus the held draft through getSuggested only
    const creator = asViewer({ id: w.creator.userId, role: "creator" });
    expect((await getThread(creator, w.normal.id)).messages.map((m) => m.body)).toEqual(["hello there", "visible reply"]);
    expect(await getSuggested(creator, w.normal.id)).toMatchObject({ id: held.id, body: "held draft" });
  });

  test("fan_thread_carries_the_browser_id_of_the_fans_own_messages_only", async () => {
    const w = await world();
    const sent = await addMessage(w.normal.id, "fan", "with a client id", { ageSeconds: 2 });
    const clientMsgId = `cid-${sent.id}`;
    await db.update(messages).set({ clientMsgId }).where(eq(messages.id, sent.id));
    await addMessage(w.normal.id, "ai", "reply", { ageSeconds: 1 });

    // the fan's page matches its pending bubble to the saved message by this id, so it never shows twice
    const fanView = await getThread(asViewer({ id: w.fanA.id, role: "fan" }), w.normal.id);
    expect(fanView.messages.find((m) => m.body === "with a client id")?.clientMsgId).toBe(clientMsgId);
    expect(fanView.messages.find((m) => m.body === "reply")?.clientMsgId).toBeNull();

    // a creator never receives the fan's browser ids
    const creatorView = await getThread(w.creatorUser, w.normal.id);
    expect(creatorView.messages.every((m) => m.clientMsgId === null)).toBe(true);
  });

  test("aiPending is true only while a fresh fan message waits on an AI-mode conversation", async () => {
    const w = await world();
    const fan = asViewer({ id: w.fanA.id, role: "fan" });
    expect((await getThread(fan, w.normal.id)).aiPending).toBe(true);
    await setMode(w.normal.id, "handoff_creator");
    expect((await getThread(fan, w.normal.id)).aiPending).toBe(false);
  });
});

describe("fan restriction in the thread meta", () => {
  test("fanRestricted is set only for a fan flagged minor_in_chat, so staff are not offered Release to AI", async () => {
    const w = await world();
    const admin = asViewer(await makeAdmin());
    expect((await getThread(admin, w.normal.id)).conversation.fanRestricted).toBe(false);
    await db.update(users).set({ flaggedAt: new Date(), flagReason: "banned by trust and safety" }).where(eq(users.id, w.fanA.id));
    expect((await getThread(admin, w.normal.id)).conversation.fanRestricted).toBe(false);
    await db.update(users).set({ flagReason: "minor_in_chat" }).where(eq(users.id, w.fanA.id));
    expect((await getThread(admin, w.normal.id)).conversation.fanRestricted).toBe(true);
  });
});

describe("inbox badges", () => {
  test("inbox_badges_follow_mode_and_open_handoff", async () => {
    const w = await world();
    const third = await makeConversation(w.creator.id, (await makeFan()).id);
    const fourth = await makeConversation(w.creator.id, (await makeFan()).id);
    await setMode(w.risky.id, "handoff_creator");
    await makeCreatorHandoff(w.risky.id);
    await setMode(third.id, "human_creator");
    await makeCreatorHandoff(fourth.id); // an alert: the AI keeps replying but Juno should look
    const rows = await listInbox(w.creatorUser);
    const badge = (id: string) => rows.find((r) => r.id === id)?.badge;
    expect(rows).toHaveLength(4);
    expect(badge(w.normal.id)).toBe("AI");
    expect(badge(w.risky.id)).toBe("Handoff");
    expect(badge(third.id)).toBe("You");
    expect(badge(fourth.id)).toBe("Handoff");
    expect(rows.find((r) => r.id === w.normal.id)?.preview).toBe("hello there");
  });
});

describe("offer card state", () => {
  const row = (over: Partial<Parameters<typeof toThreadMessage>[1]>) => ({
    id: "m1",
    sender: "ai" as const,
    body: "this one",
    clientMsgId: null,
    senderUserId: null,
    at: "2026-11-04T18:00:00.000Z",
    ageMs: 0,
    offerId: "o1",
    offerStatus: "open",
    offerLive: true,
    offerPrice: 999,
    title: "Golden hour",
    teaser: "rooftop",
    ...over,
  });
  const viewer = { role: "fan" as const, id: "f1" };

  test("an open offer for an item he does not own is locked", () => {
    expect(toThreadMessage(viewer, row({})).offer?.state).toBe("locked");
  });

  test("an open re-offer of an item he already owns is locked with its price: he buys it again", () => {
    // The card reads only the offer's status; owning the item from an earlier purchase does not unlock this offer.
    expect(toThreadMessage(viewer, row({})).offer).toMatchObject({ state: "locked", priceCents: 999 });
    expect(toThreadMessage(viewer, row({ offerStatus: "accepted" })).offer?.state).toBe("unlocked");
    expect(toThreadMessage(viewer, row({ offerStatus: "expired", offerLive: false })).offer?.state).toBe("expired");
  });
});
