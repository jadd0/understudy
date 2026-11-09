import { eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { handoffs, messages, offers, turns, users } from "@/db/schema";
import { addMessage, getConversation, makeConversation, makeCreator, makeFan, deferred, rig, world } from "@understudy/engine/testing";
import { runTurn } from "@understudy/engine";
import { handBack, takeover, TakeoverRefused } from "./actions";

async function admin() {
  const [u] = await db.insert(users).values({ email: `${crypto.randomUUID()}@test.invalid`, role: "admin" }).returning();
  return u;
}

describe("takeover", () => {
  test("moves the conversation to the human, claims the handoff, and supersedes AI rows the fan has not seen", async () => {
    const creator = await makeCreator();
    const fan = await makeFan();
    const conv = await makeConversation(creator.id, fan.id);
    const seen = await addMessage(conv.id, "ai", "already seen", { ageSeconds: 10 });
    const pending = await addMessage(conv.id, "ai", "still typing");
    await db.update(messages).set({ deliverAt: sql`now() + interval '5 seconds'` }).where(eq(messages.id, pending.id));
    await db.insert(handoffs).values({ conversationId: conv.id, queue: "creator", reason: "custom_request" });
    await db.execute(sql`update conversations set mode = 'handoff_creator' where id = ${conv.id}`);
    const before = await getConversation(conv.id);

    await takeover(conv.id, creator.userId);

    const after = await getConversation(conv.id);
    expect(after).toMatchObject({ mode: "human_creator", leaseToken: null });
    expect(after.version).toBe(before.version + 1);
    const status = async (id: string) => (await db.select().from(messages).where(eq(messages.id, id)))[0].status;
    expect(await status(pending.id)).toBe("superseded");
    expect(await status(seen.id)).toBe("sent");
    const [h] = await db.select().from(handoffs).where(eq(handoffs.conversationId, conv.id));
    expect(h).toMatchObject({ status: "claimed", claimedBy: creator.userId });
  });

  test("takeover_expires_unseen_offer", async () => {
    const w = await world();
    const itemId = w.itemA.id;
    const mk = async (carrier: string, delivered: boolean) => {
      const [o] = await db.insert(offers).values({ conversationId: w.conv.id, itemId, priceCents: 1777, expiresAt: sql`now() + interval '1 hour'` }).returning();
      const m = await addMessage(w.conv.id, "ai", carrier, { ageSeconds: delivered ? 30 : 0 });
      await db.update(messages).set({ offerId: o.id, ...(delivered ? {} : { deliverAt: sql`now() + interval '5 seconds'` }) }).where(eq(messages.id, m.id));
      return o.id;
    };
    const unseen = await mk("unseen offer bubble", false);
    const seen = await mk("seen offer bubble", true);
    await takeover(w.conv.id, w.creator.userId);
    const [u] = await db.select().from(offers).where(eq(offers.id, unseen));
    expect(u.status).toBe("expired");
    expect(u.resolvedAt).not.toBeNull();
    expect((await db.select().from(offers).where(eq(offers.id, seen)))[0]).toMatchObject({ status: "open", resolvedAt: null });
  });

  test("only the owning creator or an admin may take over; Trust & Safety conversations need an admin", async () => {
    const creator = await makeCreator();
    const other = await makeCreator();
    const fan = await makeFan();
    const conv = await makeConversation(creator.id, fan.id);
    await expect(takeover(conv.id, other.userId)).rejects.toMatchObject({ code: "not_allowed" });
    await expect(takeover(conv.id, fan.id)).rejects.toBeInstanceOf(TakeoverRefused);
    await expect(takeover(crypto.randomUUID(), creator.userId)).rejects.toMatchObject({ code: "not_found" });
    await db.execute(sql`update conversations set mode = 'handoff_ts' where id = ${conv.id}`);
    await expect(takeover(conv.id, creator.userId)).rejects.toMatchObject({ code: "not_allowed" });
    const a = await admin();
    await takeover(conv.id, a.id);
    expect((await getConversation(conv.id)).mode).toBe("human_ts");
  });

  test("an admin may take over a conversation in any mode, and it moves to the T&S side", async () => {
    const creator = await makeCreator();
    for (const mode of ["ai", "handoff_creator", "human_creator"] as const) {
      const conv = await makeConversation(creator.id, (await makeFan()).id);
      await db.execute(sql`update conversations set mode = ${mode} where id = ${conv.id}`);
      await takeover(conv.id, (await admin()).id);
      expect((await getConversation(conv.id)).mode).toBe("human_ts");
    }
  });

  test("a turn in flight when the creator takes over is superseded, not sent", async () => {
    const w = await world();
    const reached = deferred();
    const gate = deferred();
    const r = rig({
      generator: {
        latch: async () => {
          reached.resolve();
          await gate.promise;
        },
      },
    });
    const running = runTurn(w.conv.id, r.deps);
    await reached.promise;
    await takeover(w.conv.id, w.creator.userId);
    gate.resolve();
    expect(await running).toMatchObject({ status: "superseded" });
    expect((await db.select().from(turns).where(eq(turns.conversationId, w.conv.id)))[0].outcome).toBe("superseded");
  });
});

describe("handBack", () => {
  test("returns the conversation to the AI, resolves its handoff, and stamps what a human already handled", async () => {
    const w = await world();
    await db.insert(handoffs).values({ conversationId: w.conv.id, queue: "creator", reason: "unsure" });
    await takeover(w.conv.id, w.creator.userId);
    await addMessage(w.conv.id, "creator", "juno answered");
    await handBack(w.conv.id);
    expect(await getConversation(w.conv.id)).toMatchObject({ mode: "ai", failedTurns: 0 });
    const [h] = await db.select().from(handoffs).where(eq(handoffs.conversationId, w.conv.id));
    expect(h.status).toBe("resolved");
    const [m] = await db.select().from(messages).where(eq(messages.id, w.first.id));
    expect(m.turnId).not.toBeNull();
  });
});
