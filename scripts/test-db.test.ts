import { describe, expect, test } from "vitest";
// @ts-expect-error the script is plain JavaScript
import { assertDisposable, recreateDisposable } from "./test-db.mjs";

/** A pool double that records every statement and the connection it ran on. */
function fakeAdmin() {
  const statements: string[] = [];
  const client = { query: async (sql: string) => void statements.push(sql), release: () => statements.push("release") };
  return { admin: { connect: async () => client }, statements };
}

describe("test database hardening", () => {
  test("a name without _test_ is never dropped", async () => {
    for (const name of ["understudy", "understudy_dev", "understudy_testing", "prod", "UNDERSTUDY_test_x", 'x_test_"; drop database y; --']) {
      const { admin, statements } = fakeAdmin();
      await expect(recreateDisposable(admin, name)).rejects.toThrow();
      expect(statements).toEqual([]);
    }
    expect(() => assertDisposable("understudy_test_pr_3c2_server_s1")).not.toThrow();
  });

  test("a drop runs between taking and releasing the advisory lock", async () => {
    const { admin, statements } = fakeAdmin();
    await recreateDisposable(admin, "understudy_test_branch_s2");
    expect(statements.map((s) => s.split(" ").slice(0, 3).join(" "))).toEqual([
      "select pg_advisory_lock($1)",
      "drop database if",
      "create database \"understudy_test_branch_s2\"",
      "select pg_advisory_unlock($1)",
      "release",
    ]);
  });
});
