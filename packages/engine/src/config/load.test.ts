import { describe, expect, test, vi } from "vitest";
import { ENGINE_CONFIG, RETRIEVAL_CONFIG, WALLET_CONFIG } from "@/db/seed";
import { getConfig, loadEngineConfig, resetDisabledWarnings } from "./load";
import { ConfigMissing, type ConfigPort, type ConfigRow } from "../ports/config";

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
    const err = (await getConfig({ config }, "engine.lease_ms").catch((e) => e)) as ConfigMissing;
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
    // The fallback generator's model is priced too, so a turn it serves is costed at its own rows.
    expect(Object.keys(cfg.prices).sort()).toEqual([cfg.jevModel, cfg.generateModel, cfg.memoryModel, ENGINE_CONFIG["model.generate_fallback"] as string].filter((m, i, a) => a.indexOf(m) === i).sort());
    expect(cfg.prices[cfg.generateModel].input).toBe(ENGINE_CONFIG[`price.${cfg.generateModel}.input_per_mtok`]);
  });
});

describe("safety toggles", () => {
  const rows = (over: Record<string, unknown> = {}, extra: ConfigRow[] = []) => [
    ...platformRows().filter((r) => !(r.key in over)),
    ...Object.entries(over).map(([k, v]) => platform(k, v)),
    ...extra,
  ];
  const warn = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  test("every check is on by default and warns nothing", async () => {
    resetDisabledWarnings();
    const spy = warn();
    const cfg = await loadEngineConfig({ config: portOver(rows()) }, CREATOR);
    expect(Object.values(cfg.route.enabled)).toEqual([true, true, true, true, true]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test("a creator row for safety.minor.enabled is ignored: the platform value wins", async () => {
    const creatorOff: ConfigRow = { key: "safety.minor.enabled", value: false, creatorId: CREATOR };
    const cfg = await loadEngineConfig({ config: portOver(rows({}, [creatorOff])) }, CREATOR);
    expect(cfg.route.enabled.minor).toBe(true);
    expect(await getConfig({ config: portOver(rows({}, [creatorOff])) }, "safety.minor.enabled", CREATOR)).toBe(true);
    // the platform can switch it off, and a creator row cannot switch it back on or off differently
    const spy = warn();
    const off = await loadEngineConfig({ config: portOver(rows({ "safety.minor.enabled": false }, [{ ...creatorOff, value: true }])) }, CREATOR);
    expect(off.route.enabled.minor).toBe(false);
    spy.mockRestore();
  });

  test("a non-boolean row is a configuration error, never a quiet off", async () => {
    for (const bad of ["false", 0, null]) {
      await expect(loadEngineConfig({ config: portOver(rows({ "safety.threat.enabled": bad })) }, CREATOR), String(bad)).rejects.toBeInstanceOf(ConfigMissing);
    }
  });

  test("a missing row throws ConfigMissing: there is no code default", async () => {
    const without = platformRows().filter((r) => r.key !== "safety.self_harm.enabled");
    await expect(loadEngineConfig({ config: portOver(without) }, CREATOR)).rejects.toBeInstanceOf(ConfigMissing);
  });

  test("the warning names every disabled check once per process for the same set", async () => {
    resetDisabledWarnings();
    const spy = warn();
    const all = Object.fromEntries(["minor", "self_harm", "threat", "location_offplatform", "payment_dispute"].map((k) => [`safety.${k}.enabled`, false]));
    const config = portOver(rows(all));
    const cfg = await loadEngineConfig({ config }, CREATOR);
    await loadEngineConfig({ config }, CREATOR);
    expect(Object.values(cfg.route.enabled)).toEqual([false, false, false, false, false]);
    expect(spy).toHaveBeenCalledTimes(1);
    for (const k of ["minor", "self_harm", "threat", "location_offplatform", "payment_dispute"]) expect(String(spy.mock.calls[0][0])).toContain(k);
    // a different set warns again
    await loadEngineConfig({ config: portOver(rows({ "safety.minor.enabled": false })) }, CREATOR);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
