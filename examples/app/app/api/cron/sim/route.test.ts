import { beforeEach, describe, expect, test, vi } from "vitest";

const getConfig = vi.fn();
const advanceRun = vi.fn();
const liveRuns = vi.fn();
vi.mock("@/lib/config", () => ({ getConfig }));
vi.mock("@/lib/sim/run", () => ({ advanceRun, liveRuns }));
vi.mock("@/lib/sim/deps", () => ({ simDeps: async () => ({ fake: true }) }));

const call = async (headers: Record<string, string> = {}) => {
  const { GET } = await import("./route");
  return GET(new Request("http://x.test/api/cron/sim", { headers }));
};

beforeEach(() => {
  getConfig.mockReset();
  advanceRun.mockReset();
  liveRuns.mockReset();
  process.env.CRON_SECRET = "cron-secret";
});

describe("sim cron tick", () => {
  test("cron_secret_required", async () => {
    for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: "cron-secret" }] as Record<string, string>[]) {
      expect((await call(headers)).status).toBe(401);
    }
    delete process.env.CRON_SECRET;
    expect((await call({ authorization: "Bearer undefined" })).status).toBe(401);
    expect(getConfig).not.toHaveBeenCalled();
    expect(advanceRun).not.toHaveBeenCalled();
  });

  test("disabled_sim_advances_nothing", async () => {
    getConfig.mockImplementation(async (k: string) => (k === "sim.enabled" ? false : 5));
    liveRuns.mockResolvedValue([{ id: "r1" }]);
    const res = await call({ authorization: "Bearer cron-secret" });
    expect(await res.json()).toEqual({ enabled: false, runs: 0, advanced: 0 });
    expect(liveRuns).not.toHaveBeenCalled();
    expect(advanceRun).not.toHaveBeenCalled();
  });

  test("an enabled tick advances each live run within the tick budget", async () => {
    getConfig.mockImplementation(async (k: string) => ({ "sim.enabled": true, "sim.max_concurrent_runs": 2, "sim.tick_budget_ms": 45000 })[k]);
    liveRuns.mockResolvedValue([{ id: "r1" }, { id: "r2" }]);
    advanceRun.mockResolvedValue({ advanced: 3, reason: "budget" });
    const res = await call({ authorization: "Bearer cron-secret" });
    expect(await res.json()).toEqual({ enabled: true, runs: 2, advanced: 6 });
    expect(liveRuns).toHaveBeenCalledWith(2);
    expect(advanceRun.mock.calls.map((c) => [c[0], c[2]])).toEqual([["r1", { budgetMs: 45000 }], ["r2", { budgetMs: 45000 }]]);
  });
});
