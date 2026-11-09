import { describe, expect, test } from "vitest";
import { ENGINE_CONFIG, RETRIEVAL_CONFIG, WALLET_CONFIG } from "@/db/seed";
import { getConfig, loadEngineConfig } from "./cfg";
import { ConfigMissing, type ConfigPort, type ConfigRow } from "./ports/config";

const CREATOR = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

/** A port over a literal row list that behaves like the host's: platform rows, plus the asked creator's rows. */
function portOver(rows: ConfigRow[]): ConfigPort & { queries: { keys: string[]; prefixes: string[]; creatorId?: string }[] } {
  const queries: { keys: string[]; prefixes: string[]; creatorId?: string }[] = [];
  return {
    queries,
    async rows(q) {
      queries.push(q);
      return rows.filter(
        (r) =>
          (q.keys.includes(r.key) || q.prefixes.some((p) => r.key.startsWith(p))) &&
          (r.creatorId === null || r.creatorId === q.creatorId),
      );
    },
  };
}

const platform = (key: string, value: unknown): ConfigRow => ({ key, value, creatorId: null });
const platformRows = () => Object.entries({ ...WALLET_CONFIG, ...RETRIEVAL_CONFIG, ...ENGINE_CONFIG }).map(([key, value]) => platform(key, value));

describe("engine config through the port", () => {
  test("a creator row wins over the platform row", async () => {
    const config = portOver([platform("engine.lease_ms", 1000), { key: "engine.lease_ms", value: 2000, creatorId: CREATOR }]);
    expect(await getConfig({ config }, "engine.lease_ms", CREATOR)).toBe(2000);
    expect(await getConfig({ config }, "engine.lease_ms", OTHER)).toBe(1000);
    expect(await getConfig({ config }, "engine.lease_ms")).toBe(1000);
  });

  test("a creator row for a floor. or platform. key is ignored", async () => {
    const config = portOver([
      platform("floor.intent", 0.5),
      platform("platform.support_email", "support@example.test"),
      { key: "floor.intent", value: 0.01, creatorId: CREATOR },
      { key: "platform.support_email", value: "evil@example.test", creatorId: CREATOR },
    ]);
    expect(await getConfig({ config }, "floor.intent", CREATOR)).toBe(0.5);
    expect(await getConfig({ config }, "platform.support_email", CREATOR)).toBe("support@example.test");
    // The same holds when a port hands back a creator row that was not asked for.
    const loose: ConfigPort = { rows: async () => [{ key: "floor.intent", value: 0.01, creatorId: CREATOR }, platform("floor.intent", 0.5)] };
    expect(await getConfig({ config: loose }, "floor.intent", CREATOR)).toBe(0.5);
    const stranger: ConfigPort = { rows: async () => [{ key: "engine.lease_ms", value: 9, creatorId: OTHER }, platform("engine.lease_ms", 7)] };
    expect(await getConfig({ config: stranger }, "engine.lease_ms", CREATOR)).toBe(7);
  });

  test("a missing key throws ConfigMissing naming the key", async () => {
    const config = portOver([]);
    const err = await getConfig({ config }, "engine.lease_ms").catch((e) => e);
    expect(err).toBeInstanceOf(ConfigMissing);
    expect(err.key).toBe("engine.lease_ms");
    // A loader with one required row absent fails closed too, naming that row.
    const rows = platformRows().filter((r) => r.key !== "engine.typing_cps");
    await expect(loadEngineConfig({ config: portOver(rows) }, CREATOR)).rejects.toMatchObject({ name: "ConfigMissing", key: "engine.typing_cps" });
  });

  test("price rows are read by prefix", async () => {
    const config = portOver(platformRows());
    const cfg = await loadEngineConfig({ config }, CREATOR);
    expect(config.queries).toHaveLength(1);
    expect(config.queries[0].prefixes).toEqual(["price."]);
    expect(config.queries[0].creatorId).toBe(CREATOR);
    expect(Object.keys(cfg.prices).sort()).toEqual([cfg.jevModel, cfg.generateModel, cfg.memoryModel].filter((m, i, a) => a.indexOf(m) === i).sort());
    expect(cfg.prices[cfg.generateModel].input).toBe(ENGINE_CONFIG[`price.${cfg.generateModel}.input_per_mtok`]);
  });
});
