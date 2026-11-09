import { describe, expect, test } from "vitest";
import { loadPersonas, touchesSharedState } from "./persona";
import { pickPersonas, seededRng, variant } from "./random";

const personas = loadPersonas();

describe("sim randomness", () => {
  test("same_seed_same_draw", () => {
    const a = pickPersonas(personas, 12, "seed-1").map((p) => p.slug);
    const b = pickPersonas(personas, 12, "seed-1").map((p) => p.slug);
    const c = pickPersonas(personas, 12, "seed-2").map((p) => p.slug);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(seededRng("x")()).toBe(seededRng("x")());
  });

  test("minor_never_drawn_without_flag", () => {
    const draw = pickPersonas(personas, 5000, "m").map((p) => p.slug);
    expect(draw.length).toBe(5000);
    expect(draw.includes("minor")).toBe(false);
    expect(pickPersonas(personas, 5000, "m", { includeMinor: true }).some((p) => p.slug === "minor")).toBe(true);
  });

  test("weights_favour_normal", () => {
    const normal = new Set(personas.filter((p) => p.weight === 5).map((p) => p.slug));
    expect(normal.size).toBe(6);
    const draw = pickPersonas(personas, 10_000, "weights");
    const share = draw.filter((p) => normal.has(p.slug)).length / draw.length;
    expect(share).toBeGreaterThan(0.6);
    expect(share).toBeLessThan(0.8);
  });

  test("variant_is_seeded", () => {
    const p = personas.find((x) => x.slug === "lonely-regular")!;
    expect(variant(p, "s")).toEqual(variant(p, "s"));
    const seen = new Set(Array.from({ length: 40 }, (_, i) => variant(p, `s${i}`).name));
    expect(seen.size).toBeGreaterThan(1);
    for (const v of [variant(p, "a"), variant(p, "b")]) {
      expect(p.variants.some((x) => x.name === v.name && x.city === v.city)).toBe(true);
      expect(v.jitter).toBeGreaterThanOrEqual(0.75);
      expect(v.jitter).toBeLessThanOrEqual(1.25);
    }
  });

  test("shared_state_personas_never_drawn_without_flag", () => {
    const shared = new Set(personas.filter((p) => touchesSharedState(p)).map((p) => p.slug));
    expect([...shared].sort()).toEqual(["nosy", "toggle-tester"]);
    expect(pickPersonas(personas, 5000, "s").some((p) => shared.has(p.slug))).toBe(false);
    expect(pickPersonas(personas, 5000, "s", { includeShared: true }).some((p) => shared.has(p.slug))).toBe(true);
  });
});
