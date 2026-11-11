import { describe, expect, test } from "vitest";
import type { EngineDb } from "@jadd0/understudy-engine";
import { ServerHost } from "./host";

const host = (cap: number) => new ServerHost({} as EngineDb, [], cap);

describe("ServerHost cap arithmetic", () => {
  test("a price fits when spent plus price is at most the cap", () => {
    const h = host(20000);
    expect(h.capAllows(0, 20000, 20000)).toBe(true);
    expect(h.capAllows(19000, 1000, 20000)).toBe(true);
    expect(h.capAllows(19000, 1001, 20000)).toBe(false);
    expect(h.capAllows(20000, 1, 20000)).toBe(false);
  });

  test("the fan facts carry the configured cap and are never at it while a cent fits", async () => {
    expect(await host(20000).fanFacts()).toEqual({ spentTodayCents: 0, capCents: 20000, atCap: false, unlocksInWindow: 0, highValue: false });
    expect(await host(0).fanFacts()).toMatchObject({ capCents: 0, atCap: true });
  });
});
