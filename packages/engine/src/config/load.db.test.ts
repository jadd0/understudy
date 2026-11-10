import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { config } from "@/db/schema";
import { ENGINE_CONFIG } from "@/db/seed";
import { loadEngineConfig } from "./load.js";
import { SWEEP_START_BUDGET_MS } from "../conversation/sweep.js";
import { makeCreator, setEngineConfig } from "../testing/db.js";
import { rig } from "../testing/harness.js";

describe("loadEngineConfig", () => {
  test("creator_cannot_override_safety_floor", async () => {
    await setEngineConfig();
    const creator = await makeCreator();
    const rows = {
      "floor.safety.minor": 0.99,
      "floor.safety.self_harm": 0.99,
      "floor.intent": 0.01,
      "platform.support_email": "evil@example.invalid",
      "pitch.max_declines": 9,
    };
    for (const [key, value] of Object.entries(rows)) await db.insert(config).values({ key, value, creatorId: creator.id });

    const cfg = await loadEngineConfig(rig().ctx, creator.id);
    expect(cfg.route.floors.minor).toBe(0.3);
    expect(cfg.route.floors.self_harm).toBe(0.3);
    expect(cfg.route.floors.intent).toBe(0.5);
    expect(cfg.supportEmail).toBe("support@understudy.example");
    // everything else a creator may still tune
    expect(cfg.route.maxDeclines).toBe(9);
  });

  test("new_engine_keys_are_read_from_config_rows", async () => {
    // A platform row removed here would fail every parallel test file (ConfigMissing is the fail-closed path), so
    // this pins that each new key is a seeded row the loader reads, with the seed's value.
    await setEngineConfig();
    const cfg = await loadEngineConfig(rig().ctx, (await makeCreator()).id);
    expect(cfg).toMatchObject({
      debounceMs: 250,
      debounceMaxMs: 8000,
      turnBudgetMs: 12000,
      gapMarkerMinutes: 30,
      foldInMax: 1,
      historyRounds: 20,
      jevContextRounds: 6,
    });
    expect(cfg.route).toMatchObject({ minGapRounds: 5, fitFloor: 0.58 });
  });

  test("seed_turn_budget_fits_lease_and_sweep", () => {
    const budget = ENGINE_CONFIG["engine.turn_budget_ms"] as number;
    const lease = ENGINE_CONFIG["engine.lease_ms"] as number;
    // after the budget a pass can still run one wait (a debounce step), Jev, two generations and two verifies
    const worstPassMs = 2000 + 600 + 2 * 2600 + 2 * 630;
    expect(budget + worstPassMs).toBeLessThan(lease);
    expect(SWEEP_START_BUDGET_MS + budget + worstPassMs).toBeLessThanOrEqual(60_000);
    expect(ENGINE_CONFIG["engine.debounce_max_ms"] as number).toBeLessThanOrEqual(budget);
  });
});
