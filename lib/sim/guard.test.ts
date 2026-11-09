import { describe, expect, test } from "vitest";
import { FakeDecider } from "@understudy/engine/testing";
import { guard } from "./guard";

const decider = (level: string) => new FakeDecider({ script: { explicitness: level } });

describe("sim content guard", () => {
  test("graphic_word_blocks_any_persona", async () => {
    for (const minor of [false, true]) {
      expect(await guard("send nudes pls", { minor, decider: null })).toEqual({ ok: false, reason: "graphic" });
    }
    expect(await guard("what a classic assignment lol", { minor: false, decider: decider("none") })).toEqual({ ok: true });
  });

  test("flirt_word_blocks_minor_only", async () => {
    expect(await guard("ur so pretty", { minor: true, decider: null })).toEqual({ ok: false, reason: "flirt" });
    expect(await guard("ur so pretty", { minor: false, decider: decider("none") })).toEqual({ ok: true });
  });

  test("jev_explicit_blocks", async () => {
    expect(await guard("something spicy", { minor: false, decider: decider("explicit") })).toEqual({ ok: false, reason: "explicit" });
    expect(await guard("something spicy", { minor: false, decider: decider("suggestive") })).toEqual({ ok: true });
  });

  test("jev_flirty_blocks_minor_only", async () => {
    expect(await guard("hey you", { minor: true, decider: decider("flirty") })).toEqual({ ok: false, reason: "explicit" });
    expect(await guard("hey you", { minor: true, decider: decider("none") })).toEqual({ ok: true });
    expect(await guard("hey you", { minor: false, decider: decider("flirty") })).toEqual({ ok: true });
  });

  test("no decider at all fails closed, for harmless text too", async () => {
    for (const minor of [false, true]) expect(await guard("hello there", { minor, decider: null })).toEqual({ ok: false, reason: "guard_unavailable" });
  });

  test("a decider that cannot answer blocks the line", async () => {
    const down = new FakeDecider({ failOn: { 1: "timeout" } });
    expect(await guard("hello", { minor: false, decider: down })).toEqual({ ok: false, reason: "guard_unavailable" });
  });

  test("the question asked is the explicitness one only", async () => {
    const d = decider("none");
    await guard("hello", { minor: false, decider: d });
    expect(d.calls.map((c) => c.keys)).toEqual([["explicitness"]]);
  });
});
