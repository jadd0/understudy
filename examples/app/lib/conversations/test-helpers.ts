// Fixtures for the conversation reads and controls. Not imported by product code.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { conversations, handoffs, messages, users } from "@/db/schema";
import { addMessage, makeConversation, makeCreator, makeFan } from "@understudy/engine/testing";
import type { Viewer } from "./read";

export { addMessage, makeConversation, makeCreator, makeFan };

export async function makeAdmin() {
  const [u] = await db.insert(users).values({ email: `${randomUUID()}@test.invalid`, role: "admin" }).returning();
  return u;
}

export const asViewer = (u: { id: string; role: "fan" | "creator" | "admin" }): Viewer => ({ id: u.id, role: u.role });

/** Puts a conversation on the Trust & Safety side with an open (or claimed/resolved) ts handoff. */
export async function moveToTs(conversationId: string, status: "open" | "claimed" | "resolved" = "open") {
  const mode = status === "claimed" ? "human_ts" : status === "open" ? "handoff_ts" : "ai";
  await db.execute(sql`update conversations set mode = ${mode}::conversation_mode where id = ${conversationId}`);
  const [h] = await db
    .insert(handoffs)
    .values({ conversationId, queue: "ts", reason: "minor", status, resolvedAt: status === "resolved" ? new Date() : null })
    .returning();
  return h;
}

export async function setMode(conversationId: string, mode: string) {
  await db.execute(sql`update conversations set mode = ${mode}::conversation_mode where id = ${conversationId}`);
}

export async function makeCreatorHandoff(conversationId: string) {
  const [h] = await db.insert(handoffs).values({ conversationId, queue: "creator", reason: "custom_request" }).returning();
  return h;
}

/** A message whose delivery is `inSeconds` ahead of the database clock. */
export async function addFuture(conversationId: string, sender: "ai", body: string, inSeconds: number) {
  const m = await addMessage(conversationId, sender, body);
  await db.update(messages).set({ deliverAt: sql`now() + make_interval(secs => ${inSeconds})` }).where(eq(messages.id, m.id));
  return m;
}

export async function convOf(id: string) {
  const [c] = await db.select().from(conversations).where(eq(conversations.id, id));
  return c;
}
