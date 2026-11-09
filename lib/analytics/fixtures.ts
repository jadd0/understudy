// A known small world for the analytics tests. Rows are inserted with explicit timestamps relative to NOW so
// every number a query returns can be written down by hand. Not imported by product code.
import { randomUUID } from "node:crypto";
import { db } from "@/db/client";
import { conversations, handoffs, ledgerEntries, messages, offers, turns, unlocks, users, wallets } from "@/db/schema";
import { eq } from "drizzle-orm";
import { NOW, makeUser } from "@/db/test-helpers";
import { makeConversation, makeCreator, makeFan, makeItem, setEngineConfig } from "@/lib/engine/test-db";
import { parseRange } from "./range";
import { makeQuery } from "./query";

export { NOW };
export const H = 3_600_000;
/** `h` hours before NOW. */
export const ago = (h: number) => new Date(NOW.getTime() - h * H);
const D = 24;

const calm = (hardship = 0.05) => ({ parsed: { intent: "smalltalk", intentP: 0.9, p: { hardship }, offerResponse: "na" } });
const MODELS = { jev: "jev-1.14.0", generate: "claude-haiku-5-5", memory: "claude-haiku-5-5" };
const TOKENS = {
  jev_in: { inputTokens: 1000, outputTokens: 10 },
  generate: { inputTokens: 2000, outputTokens: 100, cacheReadTokens: 500 },
  jev_out: { inputTokens: 500, outputTokens: 5 },
};

type TurnOver = Partial<typeof turns.$inferInsert>;

export async function buildWorld() {
  await setEngineConfig({ "retrieval.k": 5 });
  const A = await makeCreator();
  const B = await makeCreator();
  const [f1, f2, f3, f4, f5] = await Promise.all([makeFan(), makeFan(), makeFan(), makeFan(), makeFan()]);
  await db.update(users).set({ isSim: true }).where(eq(users.id, f5.id));

  const c1 = await makeConversation(A.id, f1.id);
  const c2 = await makeConversation(A.id, f2.id);
  const c3 = await makeConversation(A.id, f3.id); // Trust & Safety: hidden from the creator
  const c4 = await makeConversation(B.id, f4.id); // another creator
  const c5 = await makeConversation(A.id, f5.id);
  await db.update(conversations).set({ mode: "handoff_ts" }).where(eq(conversations.id, c3.id));
  await db.update(conversations).set({ noPitchUntil: new Date(NOW.getTime() + H) }).where(eq(conversations.id, c2.id));

  // An eval-run fan: its traffic must never reach any figure.
  const fe = await makeUser({ role: "fan", email: `eval+${randomUUID().slice(0, 8)}@understudy.test`, adultConfirmedAt: new Date("2026-01-01T00:00:00Z") });
  const c6 = await makeConversation(A.id, fe.id);

  const i1 = await makeItem(A.id, { priceCents: 999 });
  const i2 = await makeItem(A.id, { priceCents: 1499 });
  const i3 = await makeItem(A.id, { priceCents: 1999 });

  const turn = async (conversationId: string, ageH: number, over: TurnOver) => {
    const [t] = await db
      .insert(turns)
      .values({ conversationId, createdAt: ago(ageH), models: MODELS, tokens: TOKENS, jevIn: calm(), ...over })
      .returning();
    return t;
  };
  const t = {
    t1: await turn(c1.id, 26, { route: "reply", outcome: "replied", msTotal: 1000, msJevIn: 100, msGen: 800, msJevOut: 100, costMicros: 1000 }),
    t2: await turn(c1.id, 25, { route: "offer", outcome: "replied", msTotal: 2000, msJevIn: 200, msGen: 1600, msJevOut: 200, costMicros: 2000 }),
    t3: await turn(c1.id, 24, { route: "reply", outcome: "superseded", msJevIn: 300, msGen: 3000, msJevOut: 300, costMicros: 500 }),
    t4: await turn(c1.id, 20, { route: "hold_creator", outcome: "handoff", msTotal: 500, msJevIn: 400, costMicros: 100, tokens: { jev_in: TOKENS.jev_in } }),
    t5: await turn(c3.id, 20, { route: "hard_stop", outcome: "hard_stop", msTotal: 400, costMicros: 100 }),
    t6: await turn(c2.id, 18, { route: null, outcome: "error", costMicros: 0, models: null, tokens: null, jevIn: null }),
    t7: await turn(c2.id, 10, { route: "reply", outcome: "replied", msTotal: 4000, msJevIn: 500, msGen: 2800, msJevOut: 500, costMicros: 1500, jevIn: calm(0.9) }),
    t8: await turn(c1.id, 10 * D, { route: "reply", outcome: "replied", msTotal: 9999, costMicros: 9999 }),
    t9: await turn(c4.id, 10, { route: "reply", outcome: "replied", msTotal: 777, costMicros: 777 }),
    // A pitch to a fan in hardship: the guard the report exists to catch.
    t11: await turn(c6.id, 8, { route: "offer", outcome: "replied", msTotal: 50000, msJevIn: 50000, msGen: 50000, msJevOut: 50000, costMicros: 88888, jevIn: calm(0.99) }),
    t10: await turn(c2.id, 9, { route: "offer", outcome: "replied", costMicros: 0, jevIn: calm(0.8) }),
  };

  const offer = async (
    conv: { id: string },
    itemId: string,
    priceCents: number,
    ageH: number,
    status: "open" | "accepted" | "declined" | "expired",
    ttlH: number,
    turnId?: string,
  ) => {
    const [o] = await db
      .insert(offers)
      .values({ conversationId: conv.id, itemId, priceCents, status, createdAt: ago(ageH), expiresAt: ago(ageH - ttlH), turnId })
      .returning();
    return o;
  };
  const o = {
    o1: await offer(c1, i1.id, 999, 25, "accepted", 24, t.t2.id),
    o2: await offer(c2, i1.id, 999, 2 * D, "declined", 24),
    o3: await offer(c2, i2.id, 1499, 3 * D, "expired", 24),
    o4: await offer(c1, i2.id, 1499, 2 * D, "open", 12),
    o5: await offer(c2, i3.id, 1999, 26, "declined", 24),
    o6: await offer(c1, i3.id, 1999, 27, "declined", 24),
  };

  const ledger = async (
    fanId: string,
    creatorId: string | null,
    kind: "topup" | "unlock" | "tip",
    amountCents: number,
    ageH: number,
    conversationId?: string,
    offerId?: string,
  ) => {
    const [l] = await db
      .insert(ledgerEntries)
      .values({ fanId, creatorId, kind, amountCents, createdAt: ago(ageH), conversationId, offerId })
      .returning();
    return l;
  };
  await ledger(f1.id, null, "topup", 5000, 30 * D);
  // f1 unlocks i1 ten minutes after offer o1; i3 five days ago, before offer o6 existed.
  const l1 = await ledger(f1.id, A.id, "unlock", -999, 25 - 1 / 6, c1.id, o.o1.id);
  const l2 = await ledger(f1.id, A.id, "unlock", -1999, 5 * D, c1.id);
  await db.insert(unlocks).values([
    { fanId: f1.id, itemId: i1.id, ledgerEntryId: l1.id, createdAt: ago(25 - 1 / 6) },
    { fanId: f1.id, itemId: i3.id, ledgerEntryId: l2.id, createdAt: ago(5 * D) },
  ]);
  await ledger(f1.id, A.id, "tip", -500, 6, c1.id);
  await ledger(f2.id, A.id, "tip", -300, 7 * D, c2.id); // exactly one half-life old at NOW
  await ledger(f1.id, A.id, "tip", -4000, 10 * D, c1.id); // inside 30d, outside 7d
  await ledger(f3.id, A.id, "tip", -700, 4, c3.id); // T&S conversation
  await ledger(fe.id, A.id, "tip", -9000, 3, c6.id); // eval fan
  await db.insert(wallets).values({ fanId: f1.id, balanceCents: 0, dailyCapCents: 500 });

  const msg = (conversationId: string, sender: "fan" | "ai" | "creator", ageH: number, over: Partial<typeof messages.$inferInsert> = {}) =>
    ({ conversationId, sender, body: `${sender} ${ageH}`, createdAt: ago(ageH), ...over }) as typeof messages.$inferInsert;
  await db.insert(messages).values([
    msg(c1.id, "fan", 26),
    msg(c1.id, "fan", 25.5),
    msg(c1.id, "fan", 3 * D),
    msg(c1.id, "fan", 10 * D), // outside 7d
    msg(c1.id, "ai", 25.9),
    msg(c1.id, "ai", 25.4),
    msg(c1.id, "ai", 25.3, { status: "superseded" }),
    msg(c1.id, "ai", 25.2, { suggested: true }),
    msg(c1.id, "creator", 19),
    msg(c2.id, "fan", 18.5),
    msg(c2.id, "fan", 10.5),
    msg(c2.id, "ai", 10),
    msg(c5.id, "fan", 5),
    msg(c3.id, "fan", 20.5), // T&S
    msg(c4.id, "fan", 10.5), // other creator
    msg(c6.id, "fan", 8), // eval fan
    msg(c6.id, "ai", 7.9),
  ]);

  const [h1] = await db
    .insert(handoffs)
    .values({ conversationId: c1.id, queue: "creator", reason: "custom_request", status: "resolved", openedAt: ago(2 * D), claimedAt: new Date(ago(2 * D).getTime() + 60_000), resolvedAt: new Date(ago(2 * D).getTime() + 600_000) })
    .returning();
  const [h2] = await db
    .insert(handoffs)
    .values({ conversationId: c2.id, queue: "creator", reason: "unsure", status: "claimed", openedAt: ago(D), claimedAt: new Date(ago(D).getTime() + 180_000) })
    .returning();
  const [h3] = await db
    .insert(handoffs)
    .values({ conversationId: c1.id, queue: "creator", reason: "custom_request", status: "open", openedAt: ago(3) })
    .returning();
  await db.insert(handoffs).values({ conversationId: c3.id, queue: "ts", reason: "minor", status: "open", openedAt: ago(20) });
  await db.update(turns).set({ handoffId: h3.id }).where(eq(turns.id, t.t4.id));

  const scope = { creatorIds: [A.id], includeTs: false };
  const adminScope = { creatorIds: [A.id, B.id], includeTs: true };
  const q = makeQuery(scope, parseRange("7d", NOW), NOW);
  const adminQ = makeQuery(adminScope, parseRange("7d", NOW), NOW);
  const withEval = makeQuery({ ...scope, includeEval: true }, parseRange("7d", NOW), NOW);
  const q30 = makeQuery(scope, parseRange("30d", NOW), NOW);
  return { A, B, fans: { f1, f2, f3, f4, f5, fe }, convs: { c1, c2, c3, c4, c5, c6 }, items: { i1, i2, i3 }, t, o, h: { h1, h2, h3 }, scope, adminScope, q, adminQ, q30, withEval };
}

/** A creator with nothing in the database, for the empty-range cases. */
export async function emptyCreator() {
  await setEngineConfig({ "retrieval.k": 5 });
  const creator = await makeCreator();
  const scope = { creatorIds: [creator.id], includeTs: false };
  return { creator, scope, q: makeQuery(scope, parseRange("30d", NOW), NOW) };
}
