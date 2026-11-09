import { describe, expect, test } from "vitest";
import { assertEvalDatabase } from "./runner";

describe("eval database guard", () => {
  test("refuses_the_dev_database", () => {
    expect(() => assertEvalDatabase("postgres://u:p@host/neondb")).toThrow(/refuses/);
    expect(() => assertEvalDatabase("")).toThrow(/refuses/);
  });

  test("accepts_the_eval_and_test_databases", () => {
    expect(assertEvalDatabase("postgres://u:p@host/neondb_eval")).toBe("neondb_eval");
    expect(assertEvalDatabase("postgres://u:p@host/neondb_test_pr_9b")).toBe("neondb_test_pr_9b");
  });
});
