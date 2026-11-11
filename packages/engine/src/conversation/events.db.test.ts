import { randomUUID } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { conversations, ledgerEntries, messages, offers, turns, unlocks } from "@/db/schema";
import { loadEvents, loadOfferOutcomes, TIP_ROW_PREFIX } from "./events.js";
import { processConversation } from "../turn/process.js";
import { EVENT_ONLY_INSTRUCTION, OWNED_ITEM_LINE, OWNS_ALL_LINE, TIP_LINE, unlockLine } from "../drafting/prompt.js";
import { addMessage, getConversation, makeItem } from "../testing/db.js";
import { isMemoryCall, rig, world } from "../testing/harness.js";
import { runTurn } from "../turn/run.js";

const turnsOf = (conversationId: string) =>
  db.select().from(turns).where(eq(turns.conversationId, conversationId)).orderBy(asc(turns.createdAt), asc(turns.id));
const aiOf = async (conversationId: string) =>
  (await db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt))).filter((m) => m.sender === "ai");
const genCalls = (r: ReturnType<typeof rig>) => r.generator.calls.filter((c) => !isMemoryCall(c));

const BUY = { intent: { value: "buy_intent", probabilities: { buy_intent: 0.9 } } };

/** A chat whose last fan message she already answered, so nothing he wrote is waiting. */
async function answeredWorld(over: Record<string, unknown> = {}) {
  const w = await world(over, "hey, how are you?");
  const [seed] = await db.insert(turns).values({ conversationId: w.conv.id, outcome: "seed" }).returning();
  await db.update(messages).set({ turnId: seed.id }).where(eq(messages.id, w.first.id));
  await addMessage(w.conv.id, "ai", "heyy im good, u?", { ageSeconds: 4, turnId: seed.id });
  return w;
}

/** The system row a tip leaves, `ageSeconds` old. */
async function tipRow(conversationId: string, fanId: string, ageSeconds = 1) {
  const [m] = await db
    .insert(messages)
    .values({
      conversationId,
      sender: "system",
      body: "You tipped $5.00",
      clientMsgId: `${TIP_ROW_PREFIX}${fanId}:${randomUUID()}`,
      createdAt: sql`now() - make_interval(secs => ${ageSeconds})`,
    })
    .returning();
  return m;
}

async function own(fanId: string, creatorId: string, itemId: string) {
  const [entry] = await db.insert(ledgerEntries).values({ fanId, kind: "unlock", amountCents: -100, creatorId }).returning();
  await db.insert(unlocks).values({ fanId, itemId, ledgerEntryId: entry.id });
}

/** An offer he just bought: accepted now, and the item is his. */
async function unlocked(w: Awaited<ReturnType<typeof world>>, itemId: string) {
  const [o] = await db
    .insert(offers)
    .values({ conversationId: w.conv.id, itemId, priceCents: 1777, status: "accepted", expiresAt: sql`now() + interval '1 hour'`, resolvedAt: sql`now()` })
    .returning();
  await own(w.fan.id, w.creator.id, itemId);
  return o;
}

describe("a tip with nothing new from him", () => {
  test("gets one thanks in her voice: no amount anywhere, no Jev read of fan text, no memory, the row stamped", async () => {
    const w = await answeredWorld();
    const tip = await tipRow(w.conv.id, w.fan.id);
    const r = rig({ replies: ["omg thank u babe, that made my day"] });
    expect(await runTurn(r.ctx, w.conv.id)).toMatchObject({ status: "committed", route: "reply", outcome: "replied" });

    const [, t] = await turnsOf(w.conv.id);
    // no fan message, so no latency sample for the analytics p50/p95
    expect(t).toMatchObject({ inboundIds: [], offerId: null, msTotal: null, draft: "omg thank u babe, that made my day" });
    expect(t.jevIn).toMatchObject({ parsed: null, events: { tips: [tip.id], unlocks: [] } });
    const [stamped] = await db.select().from(messages).where(eq(messages.id, tip.id));
    expect(stamped.turnId).toBe(t.id);
    expect((await aiOf(w.conv.id)).at(-1)).toMatchObject({ body: "omg thank u babe, that made my day", status: "sent" });

    const [gen] = genCalls(r);
    expect(gen.system.turn).toContain(EVENT_ONLY_INSTRUCTION);
    expect(gen.system.turn).toContain(TIP_LINE);
    // the chat ends on the app's marker, a user turn, so the reply is a new message and not a continuation of hers
    expect(gen.messages.at(-1)).toEqual({ role: "user", content: "— he sent you a tip —" });
    const everything = JSON.stringify([r.generator.calls, r.decider.calls]);
    for (const amount of ["$5", "5.00", "500"]) expect(everything).not.toContain(amount);
    // Jev is asked only to verify the draft; there is no fan text to classify, so nothing could hand the chat over
    expect(r.decider.calls.every((c) => c.keys.includes("on_persona"))).toBe(true);
    expect(r.generator.calls.some(isMemoryCall)).toBe(false);

    // a second trigger finds nothing left to react to
    expect(await runTurn(rig().ctx, w.conv.id)).toEqual({ status: "idle" });
  });

  test("is skipped when a human owns the chat", async () => {
    const human = await answeredWorld();
    await tipRow(human.conv.id, human.fan.id);
    await db.update(conversations).set({ mode: "handoff_creator" }).where(eq(conversations.id, human.conv.id));
    expect(await runTurn(rig().ctx, human.conv.id)).toEqual({ status: "busy" });
  });

  test("is skipped during a hardship cooldown: no draft, the lease given back", async () => {
    const cooling = await answeredWorld();
    await tipRow(cooling.conv.id, cooling.fan.id);
    await db.update(conversations).set({ noPitchUntil: sql`now() + interval '1 hour'` }).where(eq(conversations.id, cooling.conv.id));
    const r = rig();
    expect(await runTurn(r.ctx, cooling.conv.id)).toEqual({ status: "idle" });
    expect(r.generator.calls).toHaveLength(0);
    expect((await getConversation(cooling.conv.id)).leaseToken).toBeNull();
  });

  test("is not pending once older than the window or once a human has written since", async () => {
    const stale = await answeredWorld();
    await tipRow(stale.conv.id, stale.fan.id, 2 * 3600);
    expect(await loadEvents(rig().ctx, stale.conv.id, 60)).toEqual([]);

    const answered = await answeredWorld();
    await tipRow(answered.conv.id, answered.fan.id, 3);
    await addMessage(answered.conv.id, "creator", "thank u so much!!", { ageSeconds: 1 });
    expect(await loadEvents(rig().ctx, answered.conv.id, 60)).toEqual([]);
  });
});

describe("an unlock", () => {
  test("gets a check-in about the item by name, with no new offer, once", async () => {
    const w = await answeredWorld({ "pitch.min_gap_rounds": 0 });
    const o = await unlocked(w, w.itemA.id);
    const r = rig({ replies: ["sooo did u like the golden hour set?"] });
    expect(await runTurn(r.ctx, w.conv.id)).toMatchObject({ status: "committed", route: "reply" });
    const [gen] = genCalls(r);
    expect(gen.system.turn).toContain(unlockLine("Golden hour"));
    expect(gen.messages.at(-1)).toEqual({ role: "user", content: "— he unlocked Golden hour —" });
    for (const price of ["1777", "17.77"]) expect(JSON.stringify(r.generator.calls)).not.toContain(price);
    const [, t] = await turnsOf(w.conv.id);
    expect(t.jevIn).toMatchObject({ events: { tips: [], unlocks: [o.id] } });
    expect(await db.select().from(offers).where(eq(offers.conversationId, w.conv.id))).toHaveLength(1);

    expect(await loadEvents(rig().ctx, w.conv.id, 60)).toEqual([]);
    expect(await runTurn(rig().ctx, w.conv.id)).toEqual({ status: "idle" });
  });
});

describe("an event and a fan message together", () => {
  test("are answered in one turn: the thanks folded in, the offer route held back, the row stamped", async () => {
    const w = await answeredWorld({ "pitch.min_gap_rounds": 0 });
    const tip = await tipRow(w.conv.id, w.fan.id, 3);
    const fan = await addMessage(w.conv.id, "fan", "got anything new for me?", { ageSeconds: 2 });
    const r = rig({ script: BUY, replies: ["aww thank u!! and maybe ;)"] });
    expect(await processConversation(r.ctx, w.conv.id)).toBe(1);

    const [, t] = await turnsOf(w.conv.id);
    expect(t).toMatchObject({ route: "reply", inboundIds: [fan.id], offerId: null });
    expect(t.jevIn).toMatchObject({ events: { tips: [tip.id] } });
    expect((await db.select().from(messages).where(eq(messages.id, tip.id)))[0].turnId).toBe(t.id);
    const [gen] = genCalls(r);
    expect(gen.system.turn).toContain(TIP_LINE);
    expect(gen.system.turn).not.toContain(EVENT_ONLY_INSTRUCTION);
    // Jev reads the tip as a platform line, never the row's text
    const inbound = r.decider.calls[0].state as { earlier_messages: { from: string; text: string }[]; new_messages: string[] };
    expect(inbound.earlier_messages.at(-1)).toEqual({ from: "platform", text: "He just sent her a tip." });
    expect(inbound.new_messages).toEqual(["got anything new for me?"]);
    expect(await aiOf(w.conv.id)).toHaveLength(2);
  });

  test("a tip that lands while she drafts is folded into the same reply", async () => {
    const w = await world();
    const r = rig({ replies: ["hey you", "hey you, and thank u!!"] });
    let tipped = false;
    const generate = r.deps.generator.generate.bind(r.deps.generator);
    r.deps.generator.generate = async (input) => {
      if (!tipped && !isMemoryCall(input)) {
        tipped = true;
        await tipRow(w.conv.id, w.fan.id, 0);
      }
      return generate(input);
    };
    expect(await processConversation(r.ctx, w.conv.id)).toBe(1);
    const [t] = await turnsOf(w.conv.id);
    expect(t.jevOut).toEqual(expect.arrayContaining([{ folded: true }]));
    expect((t.jevIn as { events: { tips: string[] } }).events.tips).toHaveLength(1);
    expect(await aiOf(w.conv.id)).toHaveLength(1);
  });
});

describe("offer outcomes in the prompt", () => {
  test("each offered item's latest outcome, owned from his unlocks, newest first, with no price", async () => {
    const w = await world({}, "u up?");
    const itemC = await makeItem(w.creator.id, { title: "Night out", priceCents: 3999 });
    const itemD = await makeItem(w.creator.id, { title: "Beach day", priceCents: 4999 });
    const ins = (itemId: string, status: "open" | "declined" | "expired" | "accepted", expires = "1 hour") =>
      db.insert(offers).values({ conversationId: w.conv.id, itemId, priceCents: 999, status, expiresAt: sql`now() + ${expires}::interval` });
    await ins(w.itemA.id, "accepted");
    await own(w.fan.id, w.creator.id, w.itemA.id);
    await ins(w.itemB.id, "declined");
    await ins(itemC.id, "open", "-1 minute");
    await ins(itemD.id, "open");
    expect(await loadOfferOutcomes(rig().ctx, w.conv.id, w.fan.id, 10)).toEqual([
      { title: "Beach day", outcome: "open" },
      { title: "Night out", outcome: "expired" },
      { title: "Lazy Sunday", outcome: "declined" },
      { title: "Golden hour", outcome: "owned" },
    ]);
    expect(await loadOfferOutcomes(rig().ctx, w.conv.id, w.fan.id, 2)).toHaveLength(2);

    const r = rig();
    await runTurn(r.ctx, w.conv.id);
    const turn = genCalls(r)[0].system.turn;
    expect(turn).toContain("- Golden hour: he unlocked it, he owns it");
    expect(turn).toContain("- Lazy Sunday: he passed on it");
    expect(turn).toContain("Never tease something he owns as new");
    for (const price of ["999", "9.99", "1777"]) expect(turn).not.toContain(price);
  });
});

describe("a buy intent when he owns everything", () => {
  test("offers one he already owns, told to her as a favourite worth unlocking again, and she knows he has it all", async () => {
    const w = await world({ "pitch.min_gap_rounds": 0 }, "what else u got for me?");
    await own(w.fan.id, w.creator.id, w.itemA.id);
    await own(w.fan.id, w.creator.id, w.itemB.id);
    // the personal chat is never AI-offered and does not count
    await makeItem(w.creator.id, { title: "Personal chat with Juno", kind: "personal", priceCents: 9999 });
    const r = rig({ script: { ...BUY, offer_pick: "o1" }, replies: ["u have all my sets babe, but golden hour is still my fave"] });
    expect(await runTurn(r.ctx, w.conv.id)).toMatchObject({ route: "offer", outcome: "replied" });
    const [offer] = await db.select().from(offers).where(eq(offers.conversationId, w.conv.id));
    expect(offer).toMatchObject({ itemId: w.itemA.id, status: "open" });
    const turn = genCalls(r)[0].system.turn;
    expect(turn).toContain(`## Item to tease\nGolden hour: rooftop sunset\n${OWNED_ITEM_LINE}`);
    expect(turn).toContain(OWNS_ALL_LINE);
    expect(turn).not.toContain("Personal chat");
    // The owned-offer instruction replaces the selling one: a favourite he already has, worth unlocking again, never new.
    expect(turn).toContain("one of her favourites he already has, worth unlocking again");
    expect(turn).toContain("Never present it as new");
    expect(turn).not.toContain("so he wants to unlock it");
    expect(turn).not.toContain("never tell him to unlock");
  });

  test("with one item he does not own, that one is offered and the owned line is absent", async () => {
    const w = await world({ "pitch.min_gap_rounds": 0 }, "what else u got for me?");
    await own(w.fan.id, w.creator.id, w.itemA.id);
    const r = rig({ script: { ...BUY, offer_pick: "o1" }, replies: ["ooh lazy sunday is calling ur name"] });
    expect(await runTurn(r.ctx, w.conv.id)).toMatchObject({ route: "offer" });
    const [offer] = await db.select().from(offers).where(eq(offers.conversationId, w.conv.id));
    expect(offer.itemId).toBe(w.itemB.id);
    const turn = genCalls(r)[0].system.turn;
    expect(turn).not.toContain(OWNED_ITEM_LINE);
    expect(turn).not.toContain(OWNS_ALL_LINE);
    expect(turn).toContain("so he wants to unlock it");
  });

  test("a hardship turn gets neither the offers block nor the owned line, and a cooldown turn no owned line", async () => {
    const w = await world({}, "money is really tight rn, lost my job");
    await own(w.fan.id, w.creator.id, w.itemA.id);
    await own(w.fan.id, w.creator.id, w.itemB.id);
    await db.insert(offers).values({ conversationId: w.conv.id, itemId: w.itemA.id, priceCents: 999, status: "accepted", expiresAt: sql`now() + interval '1 hour'` });
    const r = rig({ script: { hardship: { value: "yes", probabilities: { yes: 0.95, no: 0.05 } } } });
    await runTurn(r.ctx, w.conv.id);
    const turn = genCalls(r)[0].system.turn;
    expect(turn).not.toContain("## What he has from you");
    expect(turn).not.toContain(OWNS_ALL_LINE);

    // the next message is calm, but the cooldown is on
    await addMessage(w.conv.id, "fan", "anyway how was ur day");
    const r2 = rig();
    await runTurn(r2.ctx, w.conv.id);
    const calm = genCalls(r2)[0].system.turn;
    expect(calm).toContain("- Golden hour: he unlocked it, he owns it");
    expect(calm).not.toContain(OWNS_ALL_LINE);
  });

  test("with nothing to offer on a reply route, she is still told he has every set", async () => {
    const w = await world({ "pitch.max_declines": 0 }, "u have anything new?");
    await own(w.fan.id, w.creator.id, w.itemA.id);
    await own(w.fan.id, w.creator.id, w.itemB.id);
    // pacing blocks any pitch (no declines allowed), so the route is a plain reply
    const r = rig({ script: BUY });
    expect(await runTurn(r.ctx, w.conv.id)).toMatchObject({ route: "reply" });
    expect(genCalls(r)[0].system.turn).toContain(OWNS_ALL_LINE);
  });
});
