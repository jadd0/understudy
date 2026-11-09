import { eq, inArray } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { conversations, ledgerEntries, messages, offers, simRuns, turns, unlocks, users, wallets } from "@/db/schema";
import { addMessage, makeFan } from "@/lib/engine/test-db";
import { assertBalanceEqualsLedger, fund } from "@/lib/wallet/test-helpers";
import { resetSim } from "./reset";
import { advanceRun } from "./run";
import { spawnRun } from "./spawn";
import { simRig, simWorld, testPersona } from "./test-helpers";
import type { Beat } from "./persona";

const BUY = { value: "buy_intent", probabilities: { buy_intent: 0.95 } };

describe("resetSim", () => {
  test("reset_deletes_sim_rows_in_fk_order", async () => {
    const w = await simWorld();
    const r = simRig({ engine: { script: { intent: BUY, offer_pick: "o1" } } });
    const beats: Beat[] = [
      { kind: "say", checkpoint: "ask", example: "what u got", expect: { queue: "none", route: "offer", offer: "yes" } },
      { kind: "topup", cents: 2500 },
      { kind: "unlock", target: "latest", result: "unlocked" },
    ];
    const persona = testPersona(beats);
    const s = await spawnRun(persona.slug, "auto", { kind: "cli" }, { creatorId: w.creator.id, personas: [persona] });
    await advanceRun(s.runId, r.deps, { budgetMs: 60_000, seats: w.seats, personas: [persona] });
    const [conv] = await db.select().from(conversations).where(eq(conversations.fanId, s.fanId));
    // the circular references (turn <-> offer, message -> turn) are really there before the delete
    expect((await db.select().from(turns).where(eq(turns.conversationId, conv.id))).some((t) => t.offerId !== null)).toBe(true);
    expect((await db.select().from(unlocks).where(eq(unlocks.fanId, s.fanId))).length).toBe(1);

    const out = await resetSim();
    expect(out.fans).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(users).where(eq(users.id, s.fanId))).toHaveLength(0);
    for (const t of [conversations, simRuns]) expect(await db.select().from(t).where(eq(t.id, t === conversations ? conv.id : s.runId))).toHaveLength(0);
    expect(await db.select().from(messages).where(eq(messages.conversationId, conv.id))).toHaveLength(0);
    expect(await db.select().from(turns).where(eq(turns.conversationId, conv.id))).toHaveLength(0);
    expect(await db.select().from(offers).where(eq(offers.conversationId, conv.id))).toHaveLength(0);
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, s.fanId))).toHaveLength(0);
    expect(await db.select().from(wallets).where(eq(wallets.fanId, s.fanId))).toHaveLength(0);
  });

  test("reset_keeps_human_fan_rows", async () => {
    const w = await simWorld();
    const human = await makeFan();
    await fund(human.id, 1234);
    const [conv] = await db.insert(conversations).values({ creatorId: w.creator.id, fanId: human.id }).returning();
    const msg = await addMessage(conv.id, "fan", "hello from a real person");

    const persona = testPersona([{ kind: "topup", cents: 500 }]);
    const sim = await spawnRun(persona.slug, "auto", { kind: "cli" }, { creatorId: w.creator.id, personas: [persona] });
    await advanceRun(sim.runId, simRig().deps, { budgetMs: 60_000, seats: w.seats, personas: [persona] });
    expect(await db.select().from(wallets).where(eq(wallets.fanId, sim.fanId))).toHaveLength(1);

    await resetSim();
    expect(await db.select().from(users).where(eq(users.id, sim.fanId))).toHaveLength(0);
    // the human fan is untouched: user, conversation, message, ledger row, balance
    expect(await db.select().from(users).where(eq(users.id, human.id))).toHaveLength(1);
    expect(await db.select().from(conversations).where(eq(conversations.id, conv.id))).toHaveLength(1);
    expect((await db.select().from(messages).where(inArray(messages.id, [msg.id]))).map((m) => m.body)).toEqual(["hello from a real person"]);
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, human.id))).toHaveLength(1);
    await assertBalanceEqualsLedger(human.id);
  });

  test("reset stops live runs first", async () => {
    const w = await simWorld();
    const persona = testPersona([{ kind: "topup", cents: 500 }]);
    const s = await spawnRun(persona.slug, "auto", { kind: "cli" }, { creatorId: w.creator.id, personas: [persona] });
    const out = await resetSim();
    expect(out.stopped).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(simRuns).where(eq(simRuns.id, s.runId))).toHaveLength(0);
  });

  test("the ledger's append-only trigger is back on after a reset", async () => {
    const w = await simWorld();
    const persona = testPersona([{ kind: "topup", cents: 500 }]);
    const s = await spawnRun(persona.slug, "auto", { kind: "cli" }, { creatorId: w.creator.id, personas: [persona] });
    await advanceRun(s.runId, simRig().deps, { budgetMs: 60_000, seats: w.seats, personas: [persona] });
    await resetSim();
    const human = await makeFan();
    await fund(human.id, 700);
    await expect(db.update(ledgerEntries).set({ amountCents: 1 }).where(eq(ledgerEntries.fanId, human.id))).rejects.toThrow();
    await expect(db.delete(ledgerEntries).where(eq(ledgerEntries.fanId, human.id))).rejects.toThrow();
  });
});
