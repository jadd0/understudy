import { describe, expect, test } from "vitest";
import { makeCreator, makeFan } from "@jadd0/understudy-engine/testing";
import { makeUser } from "@/db/test-helpers";
import { AnalyticsForbidden, analyticsScope } from "./scope";

describe("analyticsScope", () => {
  test("creator_scope_is_own", async () => {
    const mine = await makeCreator();
    const other = await makeCreator();
    const scope = await analyticsScope(mine.userId);
    expect(scope).toEqual({ creatorIds: [mine.id], includeTs: false });
    expect(scope.creatorIds).not.toContain(other.id);
  });

  test("admin_scope_is_all", async () => {
    const a = await makeCreator();
    const b = await makeCreator();
    const admin = await makeUser({ role: "admin" });
    const scope = await analyticsScope(admin.id);
    expect(scope.includeTs).toBe(true);
    expect(scope.creatorIds).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  test("fan_throws", async () => {
    const fan = await makeFan();
    await expect(analyticsScope(fan.id)).rejects.toBeInstanceOf(AnalyticsForbidden);
    await expect(analyticsScope("00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(AnalyticsForbidden);
  });
});
