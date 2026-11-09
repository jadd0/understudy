import { describe, expect, test } from "vitest";
import { deciderEntries, effectiveStrategy } from "@/lib/host/deps";

const models = { jev: "jev-1", fallback: "claude-x" };
const CLAUDE = { CLAUDE_SECRET_KEY: "c" };

describe("decider chain", () => {
  test("without a TypeSafe key Claude decides alone", () => {
    expect(deciderEntries(CLAUDE, models).map((e) => e.name)).toEqual(["claude"]);
  });

  test("with every key the chain is Jev then Claude", () => {
    expect(deciderEntries({ ...CLAUDE, TYPESAFE_SECRET_KEY: "t", VOYAGE_API_KEY: "v" }, models).map((e) => e.name)).toEqual(["jev", "claude"]);
  });
});

describe("retrieval strategy", () => {
  test("without a Voyage key every strategy is full-text search", () => {
    for (const s of ["fts", "vector", "hybrid"] as const) expect(effectiveStrategy(s, {})).toBe("fts");
  });

  test("with a Voyage key the configured strategy stands", () => {
    for (const s of ["fts", "vector", "hybrid"] as const) expect(effectiveStrategy(s, { VOYAGE_API_KEY: "v" })).toBe(s);
  });
});
