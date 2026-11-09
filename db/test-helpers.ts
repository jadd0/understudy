import { randomUUID } from "node:crypto";
import { db } from "@/db/client";
import { users } from "@/db/schema";

export const NOW = new Date("2026-11-03T12:00:00.000Z");

export async function makeUser(over: Partial<typeof users.$inferInsert> = {}) {
  const [row] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@test.invalid`, ...over })
    .returning();
  return row;
}
