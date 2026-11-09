import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "@/db/client";
import { ledgerEntries, messages, users } from "@/db/schema";
import { makeConversation, makeCreator, makeFan } from "@/lib/conversations/test-helpers";
import { setEngineConfig } from "@understudy/engine/testing";
import { fund } from "@/lib/wallet/test-helpers";

const session = { current: null as { user: { id: string } } | null };
vi.mock("@/lib/auth", () => ({ auth: async () => session.current }));
vi.mock("@/lib/conversations/events", () => ({ getEvents: () => ({ emit: async () => {} }) }));
// The engine turn a tip schedules is captured, not run: its reaction is tested in packages/engine/src/conversation/events.db.test.ts.
const scheduled: unknown[] = [];
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (task: unknown) => void scheduled.push(task) }));

// The page talks to "the" creator; each scene pins which one that is, since the shared test database holds many.
const current = { creator: null as { id: string } | null };
vi.mock("@/lib/conversations/read", async (orig) => ({
  ...(await orig<typeof import("@/lib/conversations/read")>()),
  primaryCreator: async () => current.creator,
}));

const { tipAction } = await import("./actions");

const as = (u: { id: string }) => void (session.current = { user: { id: u.id } });
beforeEach(() => {
  session.current = null;
  scheduled.length = 0;
});

async function scene() {
  await setEngineConfig();
  const creator = await makeCreator();
  current.creator = creator;
  const fan = await makeFan();
  const conv = await makeConversation(creator.id, fan.id);
  await fund(fan.id, 5000);
  return { creator, fan, conv };
}

const tipsOf = async (fanId: string) => (await db.select().from(ledgerEntries).where(and(eq(ledgerEntries.fanId, fanId), eq(ledgerEntries.kind, "tip"))));

describe("tip action", () => {
  test("a tip debits the ledger once, carries the conversation, and posts one system row, even when retried", async () => {
    const w = await scene();
    as(w.fan);
    const key = crypto.randomUUID();
    expect(await tipAction(key, 500)).toEqual({ ok: true });
    expect(await tipAction(key, 500)).toEqual({ ok: true });
    const tips = await tipsOf(w.fan.id);
    expect(tips).toHaveLength(1);
    expect(tips[0]).toMatchObject({ amountCents: -500, conversationId: w.conv.id });
    const rows = await db.select().from(messages).where(and(eq(messages.conversationId, w.conv.id), eq(messages.sender, "system")));
    expect(rows.map((r) => r.body)).toEqual(["You tipped $5.00"]);
    // one thanks turn for the tip, none for the retry
    expect(scheduled).toHaveLength(1);
  });

  test("below the minimum, insufficient balance and no conversation are refused without a charge", async () => {
    const w = await scene();
    as(w.fan);
    expect(await tipAction(crypto.randomUUID(), 50)).toMatchObject({ ok: false });
    expect(await tipAction(crypto.randomUUID(), 99_999)).toMatchObject({ ok: false });
    expect(await tipAction("short", 500)).toMatchObject({ ok: false });
    const lone = await makeFan();
    await fund(lone.id, 5000);
    as(lone);
    expect(await tipAction(crypto.randomUUID(), 500)).toMatchObject({ ok: false });
    expect(await tipsOf(w.fan.id)).toHaveLength(0);
    expect(await tipsOf(lone.id)).toHaveLength(0);
    expect(scheduled).toHaveLength(0);
  });

  test("a flagged or restricted fan and a signed-out caller are refused", async () => {
    const w = await scene();
    for (const reason of ["minor_in_chat", "under_18_declared"]) {
      await db.update(users).set({ flaggedAt: new Date(), flagReason: reason }).where(eq(users.id, w.fan.id));
      as(w.fan);
      await expect(tipAction(crypto.randomUUID(), 500)).rejects.toMatchObject({ digest: expect.stringContaining("/blocked") });
    }
    session.current = null;
    await expect(tipAction(crypto.randomUUID(), 500)).rejects.toMatchObject({ digest: expect.stringContaining("/signin") });
    expect(await tipsOf(w.fan.id)).toHaveLength(0);
  });
});
