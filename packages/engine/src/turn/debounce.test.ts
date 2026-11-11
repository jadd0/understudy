import { describe, expect, test } from "vitest";
import { waitForMore, waitForQuiet, type InboundState, type WaitStats } from "./debounce.js";

/** A scripted fan: `states[i]` is what the i-th load (0 = the first) reads. The last repeats. */
function fan(states: InboundState[]) {
  let loads = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    loads: () => loads,
    deps: {
      load: async () => states[Math.min(loads++, states.length - 1)],
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    },
  };
}
const S = (ids: string[], typing = false): InboundState => ({ ids, typing });
const fresh = (): WaitStats => ({ waitedMs: 0, passes: 0 });

describe("waitForQuiet", () => {
  test("burst_250ms_apart_gets_one_reply: each new message restarts the wait, then one quiet pass ends it", async () => {
    const f = fan([S(["a"]), S(["a", "b"]), S(["a", "b", "c"]), S(["a", "b", "c"])]);
    const stats = fresh();
    const out = await waitForQuiet(f.deps, { debounceMs: 250, maxMs: 8000 }, stats);
    expect(out.ids).toEqual(["a", "b", "c"]);
    expect(f.sleeps).toEqual([250, 250, 250]);
    expect(stats).toEqual({ waitedMs: 750, passes: 3 });
  });

  test("typing_fan_holds_the_turn_until_he_stops", async () => {
    const f = fan([S(["a"]), S(["a"], true), S(["a"], true), S(["a"], true), S(["a"], false)]);
    const out = await waitForQuiet(f.deps, { debounceMs: 250, maxMs: 8000 }, fresh());
    expect(out.typing).toBe(false);
    expect(f.sleeps).toHaveLength(4);
  });

  test("typing_never_holds_past_debounce_max", async () => {
    const f = fan([S(["a"], true)]);
    const stats = fresh();
    await waitForQuiet(f.deps, { debounceMs: 250, maxMs: 8000 }, stats);
    expect(stats.waitedMs).toBe(8000);
    expect(f.sleeps).toHaveLength(32);
    // a step is clipped so the sum can never pass the cap
    const g = fan([S(["a"], true)]);
    const s2 = { waitedMs: 0, passes: 0 };
    await waitForQuiet(g.deps, { debounceMs: 3000, maxMs: 8000 }, s2);
    expect(g.sleeps).toEqual([3000, 3000, 2000]);
    expect(s2.waitedMs).toBe(8000);
  });

  test("the cap is shared with earlier waits of the same turn", async () => {
    const f = fan([S(["a"], true)]);
    const stats = { waitedMs: 7900, passes: 0 };
    await waitForQuiet(f.deps, { debounceMs: 250, maxMs: 8000 }, stats);
    expect(f.sleeps).toEqual([100]);
  });

  test("zero_debounce_never_loops: one load, no sleep, even while typing", async () => {
    const f = fan([S(["a"], true)]);
    const out = await waitForQuiet(f.deps, { debounceMs: 0, maxMs: 8000 }, fresh());
    expect(out.ids).toEqual(["a"]);
    expect(f.sleeps).toEqual([]);
    expect(f.loads()).toBe(1);
  });

  test("nothing waiting means no sleep", async () => {
    const f = fan([S([])]);
    await waitForQuiet(f.deps, { debounceMs: 250, maxMs: 8000 }, fresh());
    expect(f.sleeps).toEqual([]);
  });
});

describe("waitForMore", () => {
  test("returns the grown batch as soon as a message arrives", async () => {
    const f = fan([S(["a"]), S(["a"]), S(["a", "b"])]);
    const out = await waitForMore(f.deps, { debounceMs: 250, maxMs: 8000, canStart: () => true }, fresh(), S(["a"]));
    expect(out?.ids).toEqual(["a", "b"]);
    expect(f.sleeps).toHaveLength(3);
  });

  test("still_typing_no_growth: gives up at the cap and returns null", async () => {
    const f = fan([S(["a"])]);
    const stats = fresh();
    expect(await waitForMore(f.deps, { debounceMs: 1000, maxMs: 3000, canStart: () => true }, stats, S(["a"]))).toBeNull();
    expect(stats.waitedMs).toBe(3000);
  });

  test("no_wait_past_turn_budget: canStart false means no sleep", async () => {
    const f = fan([S(["a"])]);
    expect(await waitForMore(f.deps, { debounceMs: 250, maxMs: 8000, canStart: () => false }, fresh(), S(["a"]))).toBeNull();
    expect(f.sleeps).toEqual([]);
  });
});
