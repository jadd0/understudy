import path from "node:path";
import { loadEngineConfig } from "@understudy/engine";
import { describe, expect, test } from "vitest";
import { ENGINE_CONFIG, RETRIEVAL_CONFIG, WALLET_CONFIG } from "@/db/seed";
import { jsonConfigPort, readConfigFile } from "./config";
import { SERVER_DIR } from "./seed";

const file = path.join(SERVER_DIR, "config.json");
const { rows, creatorId } = readConfigFile(file);

describe("config.json", () => {
  test("config.json holds every key the engine reads", async () => {
    const cfg = await loadEngineConfig({ config: jsonConfigPort(file) }, creatorId);
    // A missing row would have thrown ConfigMissing; the values that came back are the file's.
    expect(cfg.generateModel).toBe(rows["model.generate"]);
    expect(Object.keys(cfg.prices).length).toBeGreaterThan(0);
    expect(cfg.route.fitFloor).toBe(rows["pitch.fit_floor"]);
  });

  test("each engine row equals the app seed's value", () => {
    const seed = { ...WALLET_CONFIG, ...RETRIEVAL_CONFIG, ...ENGINE_CONFIG };
    const shared = Object.keys(rows).filter((k) => !k.startsWith("server."));
    expect(shared.length).toBeGreaterThan(50);
    for (const key of shared) expect({ key, value: rows[key] }).toEqual({ key, value: seed[key] });
    // Every engine row is in the file; the only others are the three the engine reads from outside its own list.
    const extra = shared.filter((k) => !(k in ENGINE_CONFIG)).sort();
    expect(extra).toEqual(["offer.ttl_minutes", "retrieval.k"]);
    expect(Object.keys(ENGINE_CONFIG).filter((k) => !(k in rows))).toEqual([]);
    expect(rows["server.cap_cents"]).toBe(WALLET_CONFIG["wallet.daily_cap_cents"]);
  });

  test("the port returns platform rows only, for the keys and prefixes asked", async () => {
    const port = jsonConfigPort(file);
    const got = await port.rows({ keys: ["engine.lease_ms"], prefixes: ["price.jev"], creatorId });
    expect(got.map((r) => r.key).sort()).toEqual(["engine.lease_ms", "price.jev-1.14.0.input_per_mtok", "price.jev-1.14.0.output_per_mtok"]);
    expect(got.every((r) => r.creatorId === null)).toBe(true);
  });
});
