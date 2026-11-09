import { createHash } from "node:crypto";
import { touchesSharedState, type Persona } from "./persona";

/** A small seeded generator (mulberry32 over a hash of the seed string): same seed, same sequence. */
export function seededRng(seed: string): () => number {
  let a = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function newSeed(): string {
  return createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 8);
}

/**
 * Draws `n` personas by weight (normal fans 5, edge cases 1, the minor 0) with replacement; personas that change the creator's shared state are left out unless `includeShared`. The minor has weight 0,
 * so it is only ever drawn when `includeMinor` gives it weight 1. One seed replays the whole draw.
 */
export function pickPersonas(personas: readonly Persona[], n: number, seed: string, opts: { includeMinor?: boolean; includeShared?: boolean } = {}): Persona[] {
  const rng = seededRng(`pick:${seed}`);
  const pool = personas
    .map((p) => ({ p, w: p.slug === "minor" ? (opts.includeMinor ? 1 : 0) : p.weight }))
    .filter((x) => x.w > 0 && (opts.includeShared || !touchesSharedState(x.p)));
  const total = pool.reduce((s, x) => s + x.w, 0);
  if (total === 0) throw new Error("no persona has weight");
  const out: Persona[] = [];
  for (let i = 0; i < n; i++) {
    let r = rng() * total;
    for (const x of pool) {
      r -= x.w;
      if (r < 0) {
        out.push(x.p);
        break;
      }
    }
    if (out.length === i) out.push(pool[pool.length - 1].p);
  }
  return out;
}

export interface Variant {
  name: string;
  age: number;
  city: string;
  /** Multiplies the demo gap, 0.75 to 1.25. */
  jitter: number;
}

/** The run's name, age and city from the persona's variants, plus a timing jitter, all from one seed. */
export function variant(persona: Persona, seed: string): Variant {
  const rng = seededRng(`variant:${persona.slug}:${seed}`);
  const v = persona.variants[Math.floor(rng() * persona.variants.length)];
  return { ...v, jitter: Math.round((0.75 + rng() * 0.5) * 100) / 100 };
}
