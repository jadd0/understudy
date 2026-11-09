/**
 * A per-reply draw of which voice markers this reply may use. Left to itself the model uses every marker of her voice
 * in every reply (a sign-off x, "mate", her dog's name, an emoji), far above how often she does. The sampling
 * temperature is not available, so the variation is decided here, at her measured rates, and handed to the prompt as
 * constraints. Pure: the random source is passed in, so a test or an eval can seed it.
 */

/** Her measured rates, each the share of her replies that use the marker (0..1). */
export interface StyleRates {
  signoff_x: number;
  mate: number;
  babe: number;
  pet_name: number;
  emoji: number;
  /** Her pet's name in lower case; a fan message that says it always allows it. Null when she has none. */
  pet: string | null;
}

export interface StyleDraw {
  /** A closing x or xx may end the reply. */
  signoff: boolean;
  /** The one address term the reply may use, or none. */
  address: "mate" | "babe" | null;
  /** The reply may name her pet. */
  petName: boolean;
  /** The reply may carry an emoji. */
  emoji: boolean;
}

const unit = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Reads `markers` as stored on the card; null when absent or not a rates object, which means no draw. */
export function parseRates(raw: unknown): StyleRates | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const keys = ["signoff_x", "mate", "babe", "pet_name", "emoji"] as const;
  if (!keys.every((k) => typeof o[k] === "number")) return null;
  const pet = typeof o.pet === "string" && o.pet.trim() !== "" ? o.pet.trim().toLowerCase() : null;
  return { signoff_x: unit(o.signoff_x), mate: unit(o.mate), babe: unit(o.babe), pet_name: unit(o.pet_name), emoji: unit(o.emoji), pet };
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does the fan's text say the pet's name (whole word, any case)? "eat a biscuit" counts: allowing it is the safe side. */
export function namesPet(fanText: string, pet: string | null): boolean {
  return pet !== null && new RegExp(`(?<![\\p{L}\\p{N}])${escape(pet)}(?![\\p{L}\\p{N}])`, "iu").test(fanText);
}

/** Always draws four numbers from `rng`, in a fixed order, so a seeded run is the same whatever the fan wrote. */
export function drawStyle(rates: StyleRates, fanText: string, rng: () => number): StyleDraw {
  const signoff = rng() < rates.signoff_x;
  const a = rng();
  const pet = rng() < rates.pet_name;
  const emoji = rng() < rates.emoji;
  const address = a < rates.mate ? "mate" : a < rates.mate + rates.babe ? "babe" : null;
  return { signoff, address, petName: pet || namesPet(fanText, rates.pet), emoji };
}

/** The "this reply" lines for the prompt: what is off is stated flatly, what is on is only ever "you may". */
export function drawLines(draw: StyleDraw, pet: string | null): string[] {
  const name = pet ? pet[0].toUpperCase() + pet.slice(1) : "your pet";
  const lines: string[] = [];
  lines.push(draw.signoff ? "You may end with a casual x." : "No sign-off: do not end with x or xx.");
  if (draw.address === null) lines.push('Do not call him "mate" or "babe".');
  else lines.push(`You may call him "${draw.address}" once, and do not use the other one.`);
  lines.push(draw.petName ? `You may mention ${name} if it fits.` : `Do not mention ${name}.`);
  lines.push(draw.emoji ? "You may use an emoji." : "No emoji.");
  return lines;
}
