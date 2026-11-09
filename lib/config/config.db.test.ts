import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { config, creators } from "@/db/schema";
import { ConfigMissing, getConfig } from "@/lib/config";
import { makeUser } from "@/db/test-helpers";

describe("getConfig", () => {
  test("creator row beats the platform row, and another creator sees the platform row", async () => {
    const key = `k-${randomUUID()}`;
    const mk = async () => {
      const u = await makeUser({ role: "creator" });
      const [c] = await db.insert(creators).values({ userId: u.id, handle: `h-${randomUUID()}`, displayName: "C" }).returning();
      return c.id;
    };
    const [a, b] = [await mk(), await mk()];
    await db.insert(config).values([
      { key, value: { v: "platform" } },
      { key, creatorId: a, value: { v: "creator-a" } },
    ]);
    expect(await getConfig(key, a)).toEqual({ v: "creator-a" });
    expect(await getConfig(key, b)).toEqual({ v: "platform" });
    expect(await getConfig(key)).toEqual({ v: "platform" });
  });

  test("a missing key throws ConfigMissing", async () => {
    await expect(getConfig(`absent-${randomUUID()}`)).rejects.toBeInstanceOf(ConfigMissing);
  });

  test("a second platform row for the same key is refused (nulls not distinct)", async () => {
    const key = `k-${randomUUID()}`;
    await db.insert(config).values({ key, value: 1 });
    await expect(db.insert(config).values({ key, value: 2 })).rejects.toThrow();
  });
});
