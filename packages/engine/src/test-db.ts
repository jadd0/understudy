// Database fixtures for the engine's tests. Not imported by product code.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  catalogueItems,
  config,
  conversations,
  creators,
  messages,
  personaCards,
  turns,
  users,
} from "@/db/schema";
import { ENGINE_CONFIG, RETRIEVAL_CONFIG, WALLET_CONFIG } from "@/db/seed";

export async function makeFan() {
  const [u] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@test.invalid`, role: "fan", adultConfirmedAt: new Date("2026-01-01T00:00:00Z") })
    .returning();
  return u;
}

export async function makeCreator() {
  const [u] = await db.insert(users).values({ email: `${randomUUID()}@test.invalid`, role: "creator" }).returning();
  const [c] = await db
    .insert(creators)
    .values({ userId: u.id, handle: `h-${randomUUID().slice(0, 8)}`, displayName: "Juno" })
    .returning();
  return c;
}

export async function makeConversation(creatorId: string, fanId: string) {
  const [c] = await db.insert(conversations).values({ creatorId, fanId }).returning();
  return c;
}

export async function getConversation(id: string) {
  const [c] = await db.select().from(conversations).where(eq(conversations.id, id));
  return c;
}

export async function makeItem(
  creatorId: string,
  over: Partial<typeof catalogueItems.$inferInsert> = {},
) {
  const [i] = await db
    .insert(catalogueItems)
    .values({ creatorId, kind: "ppv", title: `item-${randomUUID().slice(0, 6)}`, teaser: "a teaser", priceCents: 999, ...over })
    .returning();
  return i;
}

export async function makePersona(creatorId: string, body = "You are Juno. lowercase, warm.", neverList: string[] = []) {
  const [row] = await db.insert(personaCards).values({ creatorId, version: 1, body, neverList, publishedAt: new Date() }).returning();
  return row;
}

/** Platform config rows; overwrites so each test file controls its own numbers. */
export async function setEngineConfig(over: Record<string, unknown> = {}) {
  for (const [key, value] of Object.entries({ ...WALLET_CONFIG, ...RETRIEVAL_CONFIG, "retrieval.strategy": "fts", ...ENGINE_CONFIG, ...over })) {
    await db
      .insert(config)
      .values({ key, value })
      .onConflictDoUpdate({ target: [config.key, config.creatorId], set: { value } });
  }
}

let tick = 0;
/** A message created `ageSeconds` ago by the database clock, strictly ordered across calls. */
export async function addMessage(
  conversationId: string,
  sender: "fan" | "ai" | "creator" | "admin" | "system",
  body: string,
  over: { ageSeconds?: number; status?: "sent" | "superseded" | "blocked"; turnId?: string } = {},
) {
  const age = (over.ageSeconds ?? 0) + (1000 - tick++ ) / 1000;
  const [m] = await db
    .insert(messages)
    .values({
      conversationId,
      sender,
      body,
      status: over.status ?? "sent",
      turnId: over.turnId,
      createdAt: sql`now() - make_interval(secs => ${age})`,
    })
    .returning();
  return m;
}

/**
 * Earlier chat for a conversation, oldest first, each line `minutesAgo` old. A stand-in turn (outcome 'seed') is
 * stamped on every line so none of it counts as waiting for an answer.
 */
export async function seedChat(
  conversationId: string,
  lines: { sender: "fan" | "ai" | "creator" | "admin" | "system"; body: string; minutesAgo: number }[],
) {
  const [seed] = await db.insert(turns).values({ conversationId, outcome: "seed" }).returning();
  const out = [];
  for (const l of lines) out.push(await addMessage(conversationId, l.sender, l.body, { ageSeconds: l.minutesAgo * 60, turnId: seed.id }));
  return out;
}
