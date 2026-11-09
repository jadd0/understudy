import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import {
  catalogueItems,
  conversations,
  creators,
  handoffs,
  ledgerEntries,
  unlocks,
  wallets,
} from "@/db/schema";
import { makeUser } from "@/db/test-helpers";

async function pgError(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const cause = (e as { cause?: { code?: string; constraint?: string } }).cause;
    return { code: cause?.code, constraint: cause?.constraint };
  }
  return null;
}

async function seedConversation() {
  const cu = await makeUser({ role: "creator" });
  const [creator] = await db
    .insert(creators)
    .values({ userId: cu.id, handle: `h-${randomUUID()}`, displayName: "C" })
    .returning();
  const fan = await makeUser();
  const [conv] = await db.insert(conversations).values({ creatorId: creator.id, fanId: fan.id }).returning();
  return { creator, fan, conv };
}

const createdTables = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .flatMap((f) => [...readFileSync(join(dir, f), "utf8").matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]))
    .sort();

describe("the two migration sets", () => {
  test("the host migration set creates no engine table", () => {
    const host = createdTables(join(process.cwd(), "drizzle"));
    const engine = createdTables(join(process.cwd(), "packages/engine/drizzle"));
    expect(engine).toEqual([
      "conversations", "creator_settings", "fan_memory", "handoffs", "messages", "offers", "persona_cards", "persona_chunks", "strikes", "turns",
    ]);
    expect(host.length).toBeGreaterThan(5);
    expect(host.filter((t) => engine.includes(t))).toEqual([]);
  });

  test("creators has no ai_enabled column", async () => {
    const { rows } = await db.execute(
      `select column_name from information_schema.columns where table_name = 'creators' and table_schema = 'public' order by column_name` as never,
    );
    expect((rows as { column_name: string }[]).map((r) => r.column_name)).toEqual(["display_name", "handle", "id", "user_id"]);
  });
});

describe("schema constraints", () => {
  test("extensions vector and pg_trgm are installed", async () => {
    const { rows } = await db.execute(sql`select extname from pg_extension where extname in ('vector','pg_trgm') order by 1`);
    expect(rows.map((r) => r.extname)).toEqual(["pg_trgm", "vector"]);
  });

  test("wallet CHECK rejects a negative balance, accepts zero", async () => {
    const fan = await makeUser();
    expect(await pgError(db.insert(wallets).values({ fanId: fan.id, balanceCents: -1 }))).toEqual({
      code: "23514",
      constraint: "wallets_balance_non_negative",
    });
    await db.insert(wallets).values({ fanId: fan.id, balanceCents: 0 });
  });

  test("a second unresolved handoff for a conversation violates the partial unique; a resolved one does not", async () => {
    const { conv } = await seedConversation();
    const [first] = await db.insert(handoffs).values({ conversationId: conv.id, queue: "creator", reason: "unsure" }).returning();
    expect(await pgError(db.insert(handoffs).values({ conversationId: conv.id, queue: "ts", reason: "custom_request" }))).toEqual({
      code: "23505",
      constraint: "handoffs_one_unresolved_per_conversation",
    });
    await db.update(handoffs).set({ status: "resolved", resolvedAt: new Date() }).where(sql`${handoffs.id} = ${first.id}`);
    await db.insert(handoffs).values({ conversationId: conv.id, queue: "ts", reason: "unsure" });
  });

  test("duplicate stripe_event_id violates; null ids may repeat", async () => {
    const fan = await makeUser();
    const evt = `evt_${randomUUID()}`;
    await db.insert(ledgerEntries).values({ fanId: fan.id, kind: "topup", amountCents: 500, stripeEventId: evt });
    const dup = await pgError(db.insert(ledgerEntries).values({ fanId: fan.id, kind: "topup", amountCents: 500, stripeEventId: evt }));
    expect(dup?.code).toBe("23505");
    await db.insert(ledgerEntries).values({ fanId: fan.id, kind: "tip", amountCents: -100 });
    await db.insert(ledgerEntries).values({ fanId: fan.id, kind: "tip", amountCents: -100 });
  });

  test("duplicate (fan, item) unlock violates", async () => {
    const { creator, fan } = await seedConversation();
    const [item] = await db
      .insert(catalogueItems)
      .values({ creatorId: creator.id, kind: "ppv", title: "t", priceCents: 500 })
      .returning();
    const [entry] = await db.insert(ledgerEntries).values({ fanId: fan.id, kind: "unlock", amountCents: -500 }).returning();
    await db.insert(unlocks).values({ fanId: fan.id, itemId: item.id, ledgerEntryId: entry.id });
    const dup = await pgError(db.insert(unlocks).values({ fanId: fan.id, itemId: item.id, ledgerEntryId: entry.id }));
    expect(dup?.code).toBe("23505");
  });

  test("catalogue price must be positive", async () => {
    const { creator } = await seedConversation();
    const err = await pgError(db.insert(catalogueItems).values({ creatorId: creator.id, kind: "ppv", title: "t", priceCents: 0 }));
    expect(err).toEqual({ code: "23514", constraint: "catalogue_items_price_positive" });
  });

  test("one conversation per (creator, fan)", async () => {
    const { creator, fan } = await seedConversation();
    const err = await pgError(db.insert(conversations).values({ creatorId: creator.id, fanId: fan.id }));
    expect(err?.code).toBe("23505");
  });
});
