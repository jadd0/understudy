import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { seededRandom } from "../testing/rng";
import { drawLines, drawStyle, namesPet, parseRates, type StyleRates } from "./style-draw";

const RATES: StyleRates = { signoff_x: 0.13, mate: 0.07, babe: 0.05, pet_name: 0.035, emoji: 0.2, pet: "biscuit" };

describe("drawStyle", () => {
  test("over 500 seeded draws each marker sits within 5 points of her measured rate", () => {
    // her committed measured rates, read through the same parser the engine uses on the stored card
    const style = JSON.parse(readFileSync(new URL("../../../../data/persona/bank/style.json", import.meta.url), "utf8")) as { markers: unknown };
    const measured = parseRates(style.markers);
    expect(measured).not.toBeNull();
    const RATES = measured!;
    expect(RATES.signoff_x).toBeGreaterThan(0.1);
    const rng = seededRandom(7);
    const draws = Array.from({ length: 500 }, () => drawStyle(RATES, "hey", rng));
    const share = (f: (d: (typeof draws)[number]) => boolean) => draws.filter(f).length / draws.length;
    const near = (got: number, want: number) => expect(Math.abs(got - want)).toBeLessThanOrEqual(0.05);
    near(share((d) => d.signoff), RATES.signoff_x);
    near(share((d) => d.address === "mate"), RATES.mate);
    near(share((d) => d.address === "babe"), RATES.babe);
    near(share((d) => d.petName), RATES.pet_name);
    near(share((d) => d.emoji), RATES.emoji);
    // the draw is not constant: some of each outcome occur
    expect(draws.some((d) => d.signoff)).toBe(true);
    expect(draws.some((d) => !d.signoff)).toBe(true);
  });

  test("mate and babe are drawn at their own rates, one at a time", () => {
    const rates: StyleRates = { ...RATES, mate: 0.3, babe: 0.3 };
    const rng = seededRandom(13);
    const draws = Array.from({ length: 2000 }, () => drawStyle(rates, "hey", rng));
    const share = (a: string | null) => draws.filter((d) => d.address === a).length / draws.length;
    expect(Math.abs(share("mate") - 0.3)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(share("babe") - 0.3)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(share(null) - 0.4)).toBeLessThanOrEqual(0.05);
  });

  test("the same seed gives the same draws, whatever the fan wrote", () => {
    const a = seededRandom(3);
    const b = seededRandom(3);
    const first = Array.from({ length: 20 }, () => drawStyle(RATES, "hello", a));
    const second = Array.from({ length: 20 }, () => drawStyle(RATES, "tell me about biscuit", b));
    expect(second.map((d) => [d.signoff, d.address, d.emoji])).toEqual(first.map((d) => [d.signoff, d.address, d.emoji]));
  });

  test("the pet is allowed whenever the fan names it, and not forced otherwise", () => {
    const rates = { ...RATES, pet_name: 0 };
    const rng = seededRandom(11);
    const named = Array.from({ length: 50 }, () => drawStyle(rates, "how is Biscuit today", rng));
    expect(named).toHaveLength(50);
    expect(named.every((d) => d.petName)).toBe(true);
    const other = Array.from({ length: 50 }, () => drawStyle(rates, "how is the dog today", rng));
    expect(other.every((d) => !d.petName)).toBe(true);
    // another sense of the word still counts: the conservative side
    expect(namesPet("eat a biscuit", "biscuit")).toBe(true);
    expect(namesPet("biscuits", "biscuit")).toBe(false);
    expect(namesPet("anything", null)).toBe(false);
  });

  test("rates of 0 never allow and rates of 1 always allow", () => {
    const zero: StyleRates = { signoff_x: 0, mate: 0, babe: 0, pet_name: 0, emoji: 0, pet: null };
    const one: StyleRates = { signoff_x: 1, mate: 1, babe: 0, pet_name: 1, emoji: 1, pet: null };
    const rng = seededRandom(5);
    const lo = Array.from({ length: 200 }, () => drawStyle(zero, "x", rng));
    const hi = Array.from({ length: 200 }, () => drawStyle(one, "x", rng));
    expect(lo.every((d) => !d.signoff && d.address === null && !d.petName && !d.emoji)).toBe(true);
    expect(hi.every((d) => d.signoff && d.address === "mate" && d.petName && d.emoji)).toBe(true);
  });
});

describe("parseRates", () => {
  test("reads the stored markers and rejects anything that is not rates", () => {
    expect(parseRates({ n: 606, pet: "Biscuit", signoff_x: 0.13, mate: 0.07, babe: 0.05, pet_name: 0.03, emoji: 0.05, concrete_fact: 0.09 })).toEqual({
      signoff_x: 0.13,
      mate: 0.07,
      babe: 0.05,
      pet_name: 0.03,
      emoji: 0.05,
      pet: "biscuit",
    });
    for (const bad of [null, undefined, {}, "x", { signoff_x: 0.1 }, { signoff_x: "a", mate: 0, babe: 0, pet_name: 0, emoji: 0 }]) expect(parseRates(bad)).toBeNull();
  });
});

describe("drawLines", () => {
  test("off markers are stated flatly and on markers only as may", () => {
    const off = drawLines({ signoff: false, address: null, petName: false, emoji: false }, "biscuit").join("\n");
    expect(off).toContain("No sign-off");
    expect(off).toContain('Do not call him "mate" or "babe"');
    expect(off).toContain("Do not mention Biscuit");
    expect(off).toContain("No emoji");
    const on = drawLines({ signoff: true, address: "babe", petName: true, emoji: true }, "biscuit").join("\n");
    expect(on).not.toMatch(/must/i);
    expect(on).toContain("You may end with a casual x");
    expect(on).toContain('You may call him "babe"');
  });
});
