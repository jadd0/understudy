import { describe, expect, test, vi } from "vitest";
import type { Generator } from "@jadd0/understudy-engine";
import { deciderEntries, effectiveStrategy, gatewayWiring, generatorEntries, resetGatewayUrlWarning, type GatewayWiring } from "@/lib/host/deps";

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

const claude: Generator = { generate: async () => { throw new Error("not called"); } };
const wiring = (over: Partial<GatewayWiring> = {}): GatewayWiring => ({
  baseUrl: "http://gateway.test",
  keyFor: async () => "gw_key",
  timeoutMs: 1000,
  generate: false,
  decide: false,
  decideModel: "gpt-5-mini",
  ...over,
});

describe("the gateway in the chains", () => {
  test("gateway_off_keeps_todays_chains", () => {
    const all = { ...CLAUDE, TYPESAFE_SECRET_KEY: "t" };
    // No wiring, and wiring with both switches false, build exactly the chains of a host that has never heard of it.
    for (const gateway of [null, wiring()]) {
      expect(deciderEntries(all, models, gateway).map((e) => e.name)).toEqual(["jev", "claude"]);
      expect(deciderEntries(CLAUDE, models, gateway).map((e) => e.name)).toEqual(["claude"]);
      expect(generatorEntries(claude, "claude-y", gateway).map((e) => e.name)).toEqual(["claude", "claude-fallback"]);
    }
  });

  test("gateway_on_puts_gateway_first", () => {
    const all = { ...CLAUDE, TYPESAFE_SECRET_KEY: "t" };
    const both = wiring({ generate: true, decide: true });
    expect(deciderEntries(all, models, both).map((e) => e.name)).toEqual(["gateway", "jev", "claude"]);
    expect(deciderEntries(CLAUDE, models, both).map((e) => e.name)).toEqual(["gateway", "claude"]);
    expect(generatorEntries(claude, "claude-y", both).map((e) => e.name)).toEqual(["gateway", "claude", "claude-fallback"]);
    // Each switch moves only its own chain.
    expect(deciderEntries(all, models, wiring({ generate: true })).map((e) => e.name)).toEqual(["jev", "claude"]);
    expect(generatorEntries(claude, "claude-y", wiring({ decide: true })).map((e) => e.name)).toEqual(["claude", "claude-fallback"]);
  });
});

describe("gatewayWiring", () => {
  const rows: Record<string, unknown> = {
    "gateway.generate.enabled": false,
    "gateway.decide.enabled": false,
    "gateway.decide_model": "gpt-5-mini",
    "gateway.timeout_ms": 30000,
  };
  const read = (over: Record<string, unknown>) => async <T,>(key: string) => ({ ...rows, ...over })[key] as T;

  test("both switches false is off, whatever the environment holds", async () => {
    expect(await gatewayWiring({ GATEWAY_URL: "http://gateway.test", GATEWAY_KEY: "k" }, read({}))).toBeNull();
  });

  test("a switch on with no GATEWAY_URL is off, with a warning that names no value", async () => {
    resetGatewayUrlWarning();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await gatewayWiring({ GATEWAY_KEY: "gw_secret" }, read({ "gateway.generate.enabled": true, "gateway.decide.enabled": true }))).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).not.toContain("gw_secret");
    } finally {
      warn.mockRestore();
    }
  });

  test("the missing GATEWAY_URL warning is logged once per process, not on every send", async () => {
    resetGatewayUrlWarning();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let i = 0; i < 3; i++) expect(await gatewayWiring({}, read({ "gateway.generate.enabled": true }))).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("a switch on with a URL reads the rest of the rows", async () => {
    const w = await gatewayWiring({ GATEWAY_URL: " http://gateway.test " }, read({ "gateway.decide.enabled": true }));
    expect(w).toMatchObject({ baseUrl: "http://gateway.test", timeoutMs: 30000, generate: false, decide: true, decideModel: "gpt-5-mini" });
  });

  test("only a true row turns a switch on", async () => {
    for (const bad of ["true", 1, "yes", null]) {
      expect(await gatewayWiring({ GATEWAY_URL: "http://gateway.test" }, read({ "gateway.generate.enabled": bad }))).toBeNull();
    }
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
