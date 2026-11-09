import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "@/db/client";
import { catalogueItems, handoffs, messages, offers, personaCards, sessions, users } from "@/db/schema";
import { sendFanMessage } from "@/lib/chat/send";
import { rig, world } from "@/lib/engine/test-harness";
import { runTurn } from "@/lib/engine/turn";
import { InvalidAmount } from "@/lib/wallet/errors";
import { unlockOffer } from "@/lib/wallet/unlock";
import { balanceOf, fund, setConfig as setWalletConfig } from "@/lib/wallet/test-helpers";
import type { Events } from "@/platform/ports/events";
import {
  ban, CREATOR_OFFER_BODY, discardSuggested, Forbidden, OfferAlreadyOpen, release, releaseConversation, sendAsCreator, sendOfferAsCreator, sendSuggested, setConversationAi, setGlobalAi, setItemPrice,
  setNeverList, takeOverConversation, handBackConversation,
} from "./controls";
import { ConversationNotFound, getSnapshot, getSuggested } from "./read";
import { asViewer, convOf, makeAdmin, makeCreator, moveToTs, setMode } from "./test-helpers";

const emitted: { channel: string; event: string }[] = [];
const events: Events = { async emit(channel, event) { emitted.push({ channel, event }); } };
beforeEach(() => void (emitted.length = 0));

const creatorOf = (w: { creator: { userId: string } }) => asViewer({ id: w.creator.userId, role: "creator" });

describe("settings", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });

  test("set_global_ai_off_then_sendFanMessage_runs_no_turn", async () => {
    // no real provider may be reached even if the guard is removed
    for (const k of ["PUSHER_APP_ID", "PUSHER_KEY", "PUSHER_SECRET", "PUSHER_CLUSTER"]) delete process.env[k];
    process.env.TYPESAFE_SECRET_KEY = "not-a-real-key";
    process.env.CLAUDE_SECRET_KEY = "not-a-real-key";
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    const w = await world();
    await db.delete(messages).where(eq(messages.conversationId, w.conv.id));
    await setGlobalAi(creatorOf(w), false);
    const tasks: (() => Promise<unknown>)[] = [];
    await sendFanMessage(w.fan.id, w.creator.id, "hiii", crypto.randomUUID(), (t) => void tasks.push(t));
    expect(tasks).toHaveLength(1);
    await tasks[0]();
    const rows = await db.select().from(messages).where(eq(messages.conversationId, w.conv.id));
    expect(rows.map((m) => m.sender)).toEqual(["fan"]);
    const turnCount = await db.execute(sql`select count(*)::int as n from turns where conversation_id = ${w.conv.id}`);
    expect((turnCount.rows[0] as { n: number }).n).toBe(0);
    vi.unstubAllGlobals();
  });

  test("set_conversation_ai only for her own non-T&S conversation", async () => {
    const w = await world();
    await setConversationAi(creatorOf(w), w.conv.id, false);
    expect((await convOf(w.conv.id)).aiEnabled).toBe(false);
    const other = await makeCreator();
    await expect(setConversationAi(asViewer({ id: other.userId, role: "creator" }), w.conv.id, true)).rejects.toBeInstanceOf(ConversationNotFound);
    await moveToTs(w.conv.id);
    await expect(setConversationAi(creatorOf(w), w.conv.id, true)).rejects.toBeInstanceOf(ConversationNotFound);
    expect((await convOf(w.conv.id)).aiEnabled).toBe(false);
  });

  test("never_list_change_reaches_next_verify", async () => {
    const w = await world();
    const clean = rig({ replies: ["i adore pineapple pizza"] });
    expect(await runTurn(w.conv.id, clean.deps)).toMatchObject({ outcome: "replied" });

    const w2 = await world();
    expect(await setNeverList(creatorOf(w2), [" pineapple ", "Pineapple", "", "my ex"])).toEqual(["pineapple", "my ex"]);
    const r = rig({ replies: ["i adore pineapple pizza"] });
    const result = await runTurn(w2.conv.id, r.deps);
    expect(result).toMatchObject({ outcome: "suggested" });
    const [card] = await db.select().from(personaCards).where(eq(personaCards.creatorId, w2.creator.id));
    expect(card.neverList).toEqual(["pineapple", "my ex"]);
    // an unpublished newer draft is not the live card and is left alone
    await db.insert(personaCards).values({ creatorId: w2.creator.id, version: 2, body: "draft", neverList: ["draft term"], publishedAt: null });
    await setNeverList(creatorOf(w2), ["pineapple", "my ex"]);
    const cards = await db.select().from(personaCards).where(eq(personaCards.creatorId, w2.creator.id));
    expect(cards.find((c) => c.version === 2)?.neverList).toEqual(["draft term"]);
    await expect(setNeverList(asViewer({ id: w2.fan.id, role: "fan" }), ["x"])).rejects.toBeInstanceOf(Forbidden);
  });

  test("price_edit_changes_next_offer_not_open_offer", async () => {
    const w = await world();
    const [open] = await db
      .insert(offers)
      .values({ conversationId: w.conv.id, itemId: w.itemA.id, priceCents: w.itemA.priceCents, expiresAt: sql`now() + interval '1 day'` })
      .returning();
    await setItemPrice(creatorOf(w), w.itemA.id, 2500);
    const [item] = await db.select().from(catalogueItems).where(eq(catalogueItems.id, w.itemA.id));
    const [stillOpen] = await db.select().from(offers).where(eq(offers.id, open.id));
    expect(item.priceCents).toBe(2500);
    expect(stillOpen.priceCents).toBe(1777);
  });

  test("a price of 0, negative, fractional or someone else's item is refused", async () => {
    const w = await world();
    for (const bad of [0, -5, 12.5, Number.NaN, 3e12]) {
      await expect(setItemPrice(creatorOf(w), w.itemA.id, bad)).rejects.toBeInstanceOf(InvalidAmount);
    }
    const other = await makeCreator();
    await expect(setItemPrice(asViewer({ id: other.userId, role: "creator" }), w.itemA.id, 500)).rejects.toBeInstanceOf(Forbidden);
    const [item] = await db.select().from(catalogueItems).where(eq(catalogueItems.id, w.itemA.id));
    expect(item.priceCents).toBe(1777);
  });
});

describe("sending as the human", () => {
  test("send_suggested_sends_edited_body_as_creator", async () => {
    const w = await world();
    const r = rig({ replies: ["its $0 for you", "just 5 bucks then"] });
    await runTurn(w.conv.id, r.deps);
    const viewer = creatorOf(w);
    const draft = await getSuggested(viewer, w.conv.id);
    expect(draft?.body).toBe("just 5 bucks then");

    await sendSuggested(viewer, draft!.id, "  hey you, come say hi  ", events);
    const [m] = await db.select().from(messages).where(eq(messages.id, draft!.id));
    expect(m).toMatchObject({ sender: "creator", senderUserId: w.creator.userId, body: "hey you, come say hi", status: "sent", suggested: false, deliverAt: null });
    expect((await convOf(w.conv.id)).mode).toBe("human_creator");
    expect(await getSuggested(viewer, w.conv.id)).toBeNull();
    expect(emitted.some((e) => e.event === "message.created" && e.channel === `conversation:${w.conv.id}`)).toBe(true);
    // a second send of the same draft finds nothing to send
    await expect(sendSuggested(viewer, draft!.id, "again", events)).rejects.toBeInstanceOf(ConversationNotFound);
  });

  test("discard drops the draft; a fan or another creator cannot send it", async () => {
    const w = await world();
    await runTurn(w.conv.id, rig({ replies: ["its $0 for you", "just 5 bucks then"] }).deps);
    const draft = (await getSuggested(creatorOf(w), w.conv.id))!;
    const other = await makeCreator();
    await expect(sendSuggested(asViewer({ id: other.userId, role: "creator" }), draft.id, "mine", events)).rejects.toBeInstanceOf(ConversationNotFound);
    await expect(sendSuggested(asViewer({ id: w.fan.id, role: "fan" }), draft.id, "mine", events)).rejects.toBeInstanceOf(Forbidden);
    await discardSuggested(creatorOf(w), draft.id);
    expect(await getSuggested(creatorOf(w), w.conv.id)).toBeNull();
  });

  test("sendAsCreator needs the human mode, and takeover then hand-back moves the mode", async () => {
    const w = await world();
    const viewer = creatorOf(w);
    await expect(sendAsCreator(viewer, w.conv.id, "hello", events)).rejects.toBeInstanceOf(Forbidden);
    await takeOverConversation(viewer, w.conv.id, events);
    await sendAsCreator(viewer, w.conv.id, "hello fan", events);
    expect((await db.select().from(messages).where(eq(messages.conversationId, w.conv.id))).map((m) => m.body)).toContain("hello fan");
    await expect(sendAsCreator(viewer, w.conv.id, "   ", events)).rejects.toThrow();
    await handBackConversation(viewer, w.conv.id, events);
    expect((await convOf(w.conv.id)).mode).toBe("ai");
    await expect(sendAsCreator(viewer, w.conv.id, "late", events)).rejects.toBeInstanceOf(Forbidden);
  });

  test("a staff send keeps its browser id, shown back only to its writer, and a retry writes once", async () => {
    const w = await world();
    const admin = asViewer(await makeAdmin());
    const other = asViewer(await makeAdmin());
    await takeOverConversation(admin, w.conv.id, events);
    const cid = randomUUID();
    const first = await sendAsCreator(admin, w.conv.id, "hi from t&s", events, cid);
    expect(await sendAsCreator(admin, w.conv.id, "hi from t&s", events, cid)).toBe(first);
    expect((await db.select().from(messages).where(eq(messages.clientMsgId, cid))).length).toBe(1);
    const seen = async (v: typeof admin) => (await getSnapshot(v, w.conv.id)).thread.messages.find((m) => m.id === first)?.clientMsgId;
    expect(await seen(admin)).toBe(cid);
    expect(await seen(other)).toBeNull();
    expect(await seen(asViewer({ id: w.fan.id, role: "fan" }))).toBeNull();
  });

  test("a creator can neither take over, hand back nor message a T&S conversation", async () => {
    const w = await world();
    await moveToTs(w.conv.id);
    const viewer = creatorOf(w);
    await expect(takeOverConversation(viewer, w.conv.id, events)).rejects.toBeInstanceOf(ConversationNotFound);
    await expect(handBackConversation(viewer, w.conv.id, events)).rejects.toBeInstanceOf(ConversationNotFound);
    await expect(sendAsCreator(viewer, w.conv.id, "hi", events)).rejects.toBeInstanceOf(ConversationNotFound);
    expect((await convOf(w.conv.id)).mode).toBe("handoff_ts");
  });
});

describe("trust and safety", () => {
  test("release_resolves_and_hands_back", async () => {
    const w = await world();
    const h = await moveToTs(w.conv.id);
    const admin = asViewer(await makeAdmin());
    await takeOverConversation(admin, w.conv.id, events);
    expect((await convOf(w.conv.id)).mode).toBe("human_ts");
    await release(admin, h.id, events);
    expect((await convOf(w.conv.id)).mode).toBe("ai");
    const [row] = await db.select().from(handoffs).where(eq(handoffs.id, h.id));
    expect(row.status).toBe("resolved");
    expect(emitted.some((e) => e.channel === "ts")).toBe(true);
  });

  test("release refuses a handoff that is already resolved and changes nothing", async () => {
    const w = await world();
    const h = await moveToTs(w.conv.id);
    const admin = asViewer(await makeAdmin());
    await release(admin, h.id, events);
    await db.update(messages).set({ body: "x" }).where(eq(messages.conversationId, w.conv.id));
    await setMode(w.conv.id, "human_creator"); // she has since taken it over again
    emitted.length = 0;
    await expect(release(admin, h.id, events)).rejects.toBeInstanceOf(ConversationNotFound);
    expect((await convOf(w.conv.id)).mode).toBe("human_creator");
    expect(emitted).toHaveLength(0);
  });

  test("an admin takes over an AI chat with no T&S handoff, the creator loses sight of it, and release returns it to the AI", async () => {
    const w = await world();
    await moveToTs(w.conv.id, "resolved");
    await setMode(w.conv.id, "ai");
    const admin = asViewer(await makeAdmin());
    emitted.length = 0;
    await takeOverConversation(admin, w.conv.id, events);
    expect((await convOf(w.conv.id)).mode).toBe("human_ts");
    expect(emitted.some((e) => e.channel === `creator:${w.creator.id}`)).toBe(true);
    await releaseConversation(admin, w.conv.id, events);
    expect((await convOf(w.conv.id)).mode).toBe("ai");
    await expect(releaseConversation(admin, w.conv.id, events)).rejects.toBeInstanceOf(ConversationNotFound);
  });


  test("what the fan wrote to support while T&S held the chat is not answered by the AI after release", async () => {
    const w = await world();
    await moveToTs(w.conv.id, "resolved");
    await setMode(w.conv.id, "ai");
    const admin = asViewer(await makeAdmin());
    await takeOverConversation(admin, w.conv.id, events);
    await sendAsCreator(admin, w.conv.id, "support here, reply if it still fails", events);
    await sendFanMessage(w.fan.id, w.creator.id, "still broken tbh", randomUUID(), () => {});
    await releaseConversation(admin, w.conv.id, events);
    expect((await convOf(w.conv.id)).mode).toBe("ai");
    const waiting = await db.select({ turnId: messages.turnId }).from(messages).where(sql`${messages.conversationId} = ${w.conv.id} and ${messages.sender} = 'fan'`);
    expect(waiting.every((m) => m.turnId !== null)).toBe(true);
  });

  test("release is refused for a chat locked for a minor; the chat stays with T&S", async () => {
    const w = await world();
    await moveToTs(w.conv.id, "open");
    await db.update(users).set({ flaggedAt: sql`now()`, flagReason: "minor_in_chat" }).where(eq(users.id, w.fan.id));
    const admin = asViewer(await makeAdmin());
    await expect(releaseConversation(admin, w.conv.id, events)).rejects.toBeInstanceOf(Forbidden);
    expect((await convOf(w.conv.id)).mode).not.toBe("ai");
  });

  test("a second admin takes over a chat another admin holds, and the claim moves to them", async () => {
    const w = await world();
    const h = await moveToTs(w.conv.id);
    const first = asViewer(await makeAdmin());
    const second = asViewer(await makeAdmin());
    await takeOverConversation(first, w.conv.id, events);
    expect((await getSnapshot(second, w.conv.id)).thread.handoff?.claimedByYou).toBe(false);
    await takeOverConversation(second, w.conv.id, events);
    expect((await convOf(w.conv.id)).mode).toBe("human_ts");
    const [row] = await db.select().from(handoffs).where(eq(handoffs.id, h.id));
    expect(row.claimedBy).toBe(second.id);
    expect((await getSnapshot(second, w.conv.id)).thread.handoff?.claimedByYou).toBe(true);
  });

  test("ban_flags_and_kills_sessions", async () => {
    const w = await world();
    await db.insert(sessions).values({ sessionToken: crypto.randomUUID(), userId: w.fan.id, expires: new Date(Date.now() + 1e7) });
    const admin = asViewer(await makeAdmin());
    await ban(admin, w.fan.id);
    const [u] = await db.select().from(users).where(eq(users.id, w.fan.id));
    expect(u.flaggedAt).not.toBeNull();
    expect(await db.select().from(sessions).where(eq(sessions.userId, w.fan.id))).toHaveLength(0);
    await expect(sendFanMessage(w.fan.id, w.creator.id, "hi", crypto.randomUUID(), () => {})).rejects.toMatchObject({ code: "not_a_fan" });
  });

  test("creator_cannot_call_release_or_ban", async () => {
    const w = await world();
    const h = await moveToTs(w.conv.id);
    const viewer = creatorOf(w);
    await expect(release(viewer, h.id, events)).rejects.toBeInstanceOf(Forbidden);
    await expect(ban(viewer, w.fan.id)).rejects.toBeInstanceOf(Forbidden);
    await expect(release(asViewer({ id: w.fan.id, role: "fan" }), h.id, events)).rejects.toBeInstanceOf(Forbidden);
    // a creator on a T&S conversation also cannot reach the underlying hand-back through her own control
    await expect(handBackConversation(viewer, w.conv.id, events)).rejects.toBeInstanceOf(ConversationNotFound);
    expect((await convOf(w.conv.id)).mode).toBe("handoff_ts");
    const [row] = await db.select().from(handoffs).where(eq(handoffs.id, h.id));
    expect(row.status).toBe("open");
    const [u] = await db.select().from(users).where(eq(users.id, w.fan.id));
    expect(u.flaggedAt).toBeNull();
  });
});

describe("creator offers", () => {
  const offerRows = (convId: string) => db.select().from(offers).where(eq(offers.conversationId, convId));
  const msgRows = (convId: string) => db.select().from(messages).where(eq(messages.conversationId, convId));

  test("creator_offer_creates_offer_and_message_at_catalogue_price", async () => {
    const w = await world();
    await setMode(w.conv.id, "human_creator");
    // the catalogue price moves after the world is built; the offer copies the live row
    await db.update(catalogueItems).set({ priceCents: 4321 }).where(eq(catalogueItems.id, w.itemA.id));
    const id = await sendOfferAsCreator(creatorOf(w), w.conv.id, w.itemA.id, events);
    const rows = await offerRows(w.conv.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ itemId: w.itemA.id, priceCents: 4321, status: "open", turnId: null });
    const [{ minutes }] = (await db.execute(sql`select extract(epoch from (expires_at - created_at)) / 60 as minutes from offers where id = ${rows[0].id}`)).rows as { minutes: string }[];
    const ttl = (await db.execute(sql`select value from config where key = 'offer.ttl_minutes' and creator_id is null`)).rows[0] as { value: number };
    expect(Number(minutes)).toBeGreaterThan(0);
    expect(Math.round(Number(minutes))).toBe(Number(ttl.value));
    const [m] = await db.select().from(messages).where(eq(messages.id, id));
    expect(m).toMatchObject({ sender: "creator", senderUserId: w.creator.userId, offerId: rows[0].id, turnId: null, body: CREATOR_OFFER_BODY, status: "sent" });
    expect(emitted.some((e) => e.event === "message.created" && e.channel === `conversation:${w.conv.id}`)).toBe(true);
    expect(emitted.some((e) => e.event === "inbox.changed" && e.channel === `creator:${w.creator.id}`)).toBe(true);
  });

  test("creator_offer_refused_unless_human_creator", async () => {
    const w = await world();
    for (const mode of ["ai", "handoff_creator"]) {
      await setMode(w.conv.id, mode);
      await expect(sendOfferAsCreator(creatorOf(w), w.conv.id, w.itemA.id, events)).rejects.toBeInstanceOf(Forbidden);
    }
    // a Trust & Safety conversation is out of her scope entirely
    await setMode(w.conv.id, "human_ts");
    await expect(sendOfferAsCreator(creatorOf(w), w.conv.id, w.itemA.id, events)).rejects.toBeInstanceOf(ConversationNotFound);
    expect(await offerRows(w.conv.id)).toHaveLength(0);
    expect((await msgRows(w.conv.id)).filter((m) => m.offerId !== null)).toHaveLength(0);
  });

  test("creator_offer_refused_for_other_creators_item_or_inactive_item", async () => {
    const w = await world();
    await setMode(w.conv.id, "human_creator");
    const other = await makeCreator();
    const [foreign] = await db.insert(catalogueItems).values({ creatorId: other.id, kind: "ppv", title: "Theirs", priceCents: 100 }).returning();
    await expect(sendOfferAsCreator(creatorOf(w), w.conv.id, foreign.id, events)).rejects.toBeInstanceOf(Forbidden);
    await db.update(catalogueItems).set({ active: false }).where(eq(catalogueItems.id, w.itemB.id));
    await expect(sendOfferAsCreator(creatorOf(w), w.conv.id, w.itemB.id, events)).rejects.toBeInstanceOf(Forbidden);
    // another creator cannot offer into this conversation at all
    await expect(sendOfferAsCreator(asViewer({ id: other.userId, role: "creator" }), w.conv.id, foreign.id, events)).rejects.toBeInstanceOf(ConversationNotFound);
    expect(await offerRows(w.conv.id)).toHaveLength(0);
  });

  test("admin_cannot_send_creator_offer", async () => {
    const w = await world();
    await setMode(w.conv.id, "human_creator");
    const admin = await makeAdmin();
    await expect(sendOfferAsCreator(asViewer({ id: admin.id, role: "admin" }), w.conv.id, w.itemA.id, events)).rejects.toBeInstanceOf(Forbidden);
    await expect(sendOfferAsCreator(asViewer({ id: w.fan.id, role: "fan" }), w.conv.id, w.itemA.id, events)).rejects.toBeInstanceOf(Forbidden);
    expect(await offerRows(w.conv.id)).toHaveLength(0);
  });

  test("double_send_leaves_one_open_offer_per_item", async () => {
    const w = await world();
    await setMode(w.conv.id, "human_creator");
    const results = await Promise.allSettled([
      sendOfferAsCreator(creatorOf(w), w.conv.id, w.itemA.id, events),
      sendOfferAsCreator(creatorOf(w), w.conv.id, w.itemA.id, events),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")?.reason).toBeInstanceOf(OfferAlreadyOpen);
    expect(await offerRows(w.conv.id)).toHaveLength(1);
    // a different item is still allowed
    await sendOfferAsCreator(creatorOf(w), w.conv.id, w.itemB.id, events);
    expect(await offerRows(w.conv.id)).toHaveLength(2);
  });

  test("hand_back_before_confirm_refuses_the_offer", async () => {
    const w = await world();
    await setMode(w.conv.id, "human_creator");
    await handBackConversation(creatorOf(w), w.conv.id, events);
    await expect(sendOfferAsCreator(creatorOf(w), w.conv.id, w.itemA.id, events)).rejects.toBeInstanceOf(Forbidden);
    expect(await offerRows(w.conv.id)).toHaveLength(0);
  });

  test("fan_can_unlock_a_creator_offer", async () => {
    await setWalletConfig();
    const w = await world();
    await setMode(w.conv.id, "human_creator");
    await sendOfferAsCreator(creatorOf(w), w.conv.id, w.itemA.id, events);
    const [o] = await offerRows(w.conv.id);
    await fund(w.fan.id, 5000);
    const r = await unlockOffer(w.fan.id, o.id);
    expect(r).toMatchObject({ alreadyUnlocked: false, itemId: w.itemA.id });
    expect(await balanceOf(w.fan.id)).toBe(5000 - w.itemA.priceCents);
  });
});
