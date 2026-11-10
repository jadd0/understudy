import { describe, expect, it } from "vitest";
import { Breaker } from "./breaker.js";

function make(over: Partial<{ failures: number; windowMs: number; cooldownMs: number }> = {}) {
  const clock = { t: 1_000_000, now() { return this.t; } };
  const breaker = new Breaker({ failures: 3, windowMs: 60_000, cooldownMs: 30_000, clock, ...over });
  return { clock, breaker };
}

describe("Breaker", () => {
  it("opens after N failures in the window", () => {
    const { breaker } = make();
    breaker.failure();
    breaker.failure();
    expect(breaker.allow()).toBe(true);
    breaker.failure();
    expect(breaker.isOpen).toBe(true);
    expect(breaker.allow()).toBe(false);
  });

  it("stays open for the cooldown", () => {
    const { breaker, clock } = make();
    for (let i = 0; i < 3; i++) breaker.failure();
    clock.t += 29_999;
    expect(breaker.allow()).toBe(false);
    clock.t += 1;
    expect(breaker.allow()).toBe(true);
  });

  it("half-open lets one call through; success closes, failure re-opens", () => {
    const a = make();
    for (let i = 0; i < 3; i++) a.breaker.failure();
    a.clock.t += 30_000;
    expect(a.breaker.allow()).toBe(true);
    expect(a.breaker.allow()).toBe(false);
    a.breaker.success();
    expect(a.breaker.isOpen).toBe(false);
    expect(a.breaker.allow()).toBe(true);
    // one failure after closing does not reopen: the count restarted
    a.breaker.failure();
    expect(a.breaker.allow()).toBe(true);

    const b = make();
    for (let i = 0; i < 3; i++) b.breaker.failure();
    b.clock.t += 30_000;
    expect(b.breaker.allow()).toBe(true);
    b.breaker.failure();
    expect(b.breaker.allow()).toBe(false);
    b.clock.t += 30_000;
    expect(b.breaker.allow()).toBe(true);
  });

  it("failures outside the window do not count", () => {
    const { breaker, clock } = make();
    breaker.failure();
    breaker.failure();
    clock.t += 60_000;
    breaker.failure();
    expect(breaker.isOpen).toBe(false);
    expect(breaker.allow()).toBe(true);
  });
});
