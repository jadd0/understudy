import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { creators, users } from "@/db/schema";
import { seed } from "@/db/seed";

describe("seed", () => {
  test("running twice leaves one creator and one row per admin", async () => {
    const tag = randomUUID();
    const creatorEmail = `juno-${tag}@test.invalid`;
    const adminA = `a-${tag}@test.invalid`;
    const adminB = `b-${tag}@test.invalid`;
    const input = { creatorEmail: creatorEmail.toUpperCase(), adminEmails: ` ${adminA}, ${adminB} ,` };
    const quiet = () => {};

    await seed(input, quiet);
    await seed(input, quiet);

    const [creatorUser] = await db.select().from(users).where(eq(users.email, creatorEmail));
    expect(creatorUser.role).toBe("creator");
    const creatorRows = await db.select().from(creators).where(eq(creators.userId, creatorUser.id));
    expect(creatorRows).toHaveLength(1);
    expect(creatorRows[0]).toMatchObject({ handle: "junovale", displayName: "Juno" });

    const admins = await db.select().from(users).where(inArray(users.email, [adminA, adminB]));
    expect(admins.map((a) => a.role)).toEqual(["admin", "admin"]);
  });

  test("absent env values skip with a message and write nothing", async () => {
    const messages: string[] = [];
    await seed({}, (m) => messages.push(m));
    expect(messages).toEqual([
      "seed: SEED_CREATOR_EMAIL not set, creator skipped",
      "seed: SEED_ADMIN_EMAILS not set, admins skipped",
    ]);
  });
});
