import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { EngineDb } from "@understudy/engine";
import { jsonConfigPort, readConfigFile } from "./config";
import { readEnv } from "./env";
import { realProviders, resetGatewayUrlWarning } from "./providers";
import { SERVER_DIR } from "./seed";

const file = readConfigFile(path.join(SERVER_DIR, "config.json"));
const base = { DATABASE_URL: "postgres://x", UNDERSTUDY_API_KEY: "k", CLAUDE_SECRET_KEY: "c" };

/** The chains `realProviders` built, by entry name, read off the failover wrappers. */
async function chains(rows: Record<string, unknown>, env: Record<string, string>) {
  const providers = await realProviders({} as EngineDb, readEnv({ ...base, ...env }), jsonConfigPort({ ...file, rows: { ...file.rows, ...rows } }), env);
  const names = (x: unknown) => (x as { list: { name: string }[] }).list.map((e) => e.name);
  return { decide: names(providers.decider), generate: names(providers.generator) };
}

describe("the server's provider chains", () => {
  test("the shipped config has both gateway switches off", () => {
    expect(file.rows["gateway.generate.enabled"]).toBe(false);
    expect(file.rows["gateway.decide.enabled"]).toBe(false);
  });

  test("gateway_off_keeps_todays_chains", async () => {
    // A URL and a key in the environment change nothing while the switches are false.
    for (const env of [{}, { GATEWAY_URL: "http://gateway.test", GATEWAY_KEY: "gw_key" }] as Record<string, string>[]) {
      expect(await chains({}, env)).toEqual({ decide: ["claude"], generate: ["claude", "claude-fallback"] });
      expect(await chains({}, { ...env, TYPESAFE_SECRET_KEY: "t" })).toEqual({ decide: ["jev", "claude"], generate: ["claude", "claude-fallback"] });
    }
  });

  test("gateway_on_puts_gateway_first", async () => {
    const env = { GATEWAY_URL: "http://gateway.test", GATEWAY_KEY: "gw_key", TYPESAFE_SECRET_KEY: "t" };
    expect(await chains({ "gateway.generate.enabled": true, "gateway.decide.enabled": true }, env)).toEqual({
      decide: ["gateway", "jev", "claude"],
      generate: ["gateway", "claude", "claude-fallback"],
    });
    // Each switch moves only its own chain.
    expect(await chains({ "gateway.generate.enabled": true }, env)).toEqual({ decide: ["jev", "claude"], generate: ["gateway", "claude", "claude-fallback"] });
    expect(await chains({ "gateway.decide.enabled": true }, env)).toEqual({ decide: ["gateway", "jev", "claude"], generate: ["claude", "claude-fallback"] });
  });

  test("switches on with no GATEWAY_URL leave today's chains and warn once", async () => {
    resetGatewayUrlWarning();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await chains({ "gateway.generate.enabled": true, "gateway.decide.enabled": true }, { GATEWAY_KEY: "gw_secret" })).toEqual({
        decide: ["claude"],
        generate: ["claude", "claude-fallback"],
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).not.toContain("gw_secret");
    } finally {
      warn.mockRestore();
    }
  });

  test("the missing GATEWAY_URL warning is logged once per process, not on every build", async () => {
    resetGatewayUrlWarning();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let i = 0; i < 3; i++) await chains({ "gateway.generate.enabled": true }, {});
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
