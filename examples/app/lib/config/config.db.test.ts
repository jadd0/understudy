import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { config, creators } from "@/db/schema";
import { ConfigMissing, dbConfigPort, getConfig } from "@/lib/config";
import { ConfigMissing as EngineConfigMissing } from "@jadd0/understudy-engine";
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

describe("dbConfigPort", () => {
  test("dbConfigPort returns platform rows and only the asked creator's rows", async () => {
    const tag = `port-${randomUUID()}`;
    const mk = async () => {
      const u = await makeUser({ role: "creator" });
      const [c] = await db.insert(creators).values({ userId: u.id, handle: `h-${randomUUID()}`, displayName: "C" }).returning();
      return c.id;
    };
    const [a, b] = [await mk(), await mk()];
    await db.insert(config).values([
      { key: `${tag}.one`, value: "platform" },
      { key: `${tag}.one`, creatorId: a, value: "a" },
      { key: `${tag}.one`, creatorId: b, value: "b" },
      { key: `${tag}.two`, creatorId: a, value: "a2" },
      { key: `${tag}.unasked`, value: "no" },
    ]);
    const shape = (rows: { key: string; value: unknown; creatorId: string | null }[]) =>
      rows.map((r) => `${r.key}|${r.value}|${r.creatorId === null ? "platform" : r.creatorId === a ? "a" : "b"}`).sort();
    const asked = { keys: [`${tag}.one`, `${tag}.two`], prefixes: [] as string[] };
    expect(shape(await dbConfigPort.rows({ ...asked, creatorId: a }))).toEqual([`${tag}.one|a|a`, `${tag}.one|platform|platform`, `${tag}.two|a2|a`]);
    expect(shape(await dbConfigPort.rows({ ...asked, creatorId: b }))).toEqual([`${tag}.one|b|b`, `${tag}.one|platform|platform`]);
    expect(shape(await dbConfigPort.rows(asked))).toEqual([`${tag}.one|platform|platform`]);
    // A prefix matches every key that starts with it.
    expect(shape(await dbConfigPort.rows({ keys: [], prefixes: [`${tag}.`] }))).toEqual([`${tag}.one|platform|platform`, `${tag}.unasked|no|platform`]);
    expect(await dbConfigPort.rows({ keys: [], prefixes: [] })).toEqual([]);
  });

  test("ConfigMissing from @/lib/config and from @jadd0/understudy-engine is the same class", async () => {
    expect(ConfigMissing).toBe(EngineConfigMissing);
    const err = await getConfig(`absent-${randomUUID()}`).catch((e) => e);
    expect(err).toBeInstanceOf(EngineConfigMissing);
    expect(new EngineConfigMissing("k")).toBeInstanceOf(ConfigMissing);
  });
});
