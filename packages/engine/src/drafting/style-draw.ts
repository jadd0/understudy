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
  /** Her reply length in characters (nearest-rank percentiles); null when the card predates it, which draws no length. */
  length?: LengthPercentiles | null;
  /** Share of her replies with a line break; null when not measured, which draws nothing about lines. */
  multiline?: number | null;
  /** Share of her replies containing a question mark; null when not measured, which draws nothing about questions. */
  question?: number | null;
  /** Her pet's name in lower case; a fan message that says it always allows it. Null when she has none. */
  pet: string | null;
}

export interface LengthPercentiles {
  p25: number;
  p50: number;
  p75: number;
  p90: number;
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
  /** About how many characters the reply should run; absent when no length was drawn. */
  targetChars?: number;
  /** Whether the reply may run to a second line; absent when not drawn. */
  multiline?: boolean;
  /** Whether the reply may ask him a question; absent when not drawn. */
  question?: boolean;
}

const unit = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Reads `markers` as stored on the card; null when absent or not a rates object, which means no draw. */
export function parseRates(raw: unknown): StyleRates | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const keys = ["signoff_x", "mate", "babe", "pet_name", "emoji"] as const;
  if (!keys.every((k) => typeof o[k] === "number")) return null;
  const pet = typeof o.pet === "string" && o.pet.trim() !== "" ? o.pet.trim().toLowerCase() : null;
  return {
    signoff_x: unit(o.signoff_x),
    mate: unit(o.mate),
    babe: unit(o.babe),
    pet_name: unit(o.pet_name),
    emoji: unit(o.emoji),
    length: parseLength(o.length_chars),
    multiline: typeof o.multiline === "number" ? unit(o.multiline) : null,
    question: typeof o.question === "number" ? unit(o.question) : null,
    pet,
  };
}

function parseLength(raw: unknown): LengthPercentiles | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const vals = [o.p25, o.p50, o.p75, o.p90];
  if (!vals.every((v) => typeof v === "number" && Number.isFinite(v) && v > 0)) return null;
  const [p25, p50, p75, p90] = vals as number[];
  if (!(p25 <= p50 && p50 <= p75 && p75 <= p90)) return null;
  return { p25, p50, p75, p90 };
}

/**
 * A length from her distribution: the inverse CDF by linear interpolation between her percentiles, with the bottom
 * tail running down to half her p25 and the top tail ending at her p90, so nothing is drawn longer than she goes.
 */
export function targetLength(len: LengthPercentiles, u: number): number {
  const points: [number, number][] = [[0, len.p25 / 2], [0.25, len.p25], [0.5, len.p50], [0.75, len.p75], [0.9, len.p90], [1, len.p90]];
  for (let i = 1; i < points.length; i++) {
    const [u1, v1] = points[i];
    if (u <= u1) {
      const [u0, v0] = points[i - 1];
      return Math.round(v0 + ((u - u0) / (u1 - u0)) * (v1 - v0));
    }
  }
  return len.p90;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does the fan's text say the pet's name (whole word, any case)? "eat a biscuit" counts: allowing it is the safe side. */
export function namesPet(fanText: string, pet: string | null): boolean {
  return pet !== null && new RegExp(`(?<![\\p{L}\\p{N}])${escape(pet)}(?![\\p{L}\\p{N}])`, "iu").test(fanText);
}

/** Always draws seven numbers from `rng`, in a fixed order, so a seeded run is the same whatever the fan wrote or the card carries. */
export function drawStyle(rates: StyleRates, fanText: string, rng: () => number): StyleDraw {
  const signoff = rng() < rates.signoff_x;
  const a = rng();
  const pet = rng() < rates.pet_name;
  const emoji = rng() < rates.emoji;
  const address = a < rates.mate ? "mate" : a < rates.mate + rates.babe ? "babe" : null;
  const lengthU = rng();
  const multilineU = rng();
  const questionU = rng();
  const draw: StyleDraw = { signoff, address, petName: pet || namesPet(fanText, rates.pet), emoji };
  if (rates.length) draw.targetChars = targetLength(rates.length, lengthU);
  if (rates.multiline != null) draw.multiline = multilineU < rates.multiline;
  if (rates.question != null) draw.question = questionU < rates.question;
  return draw;
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
  if (draw.targetChars !== undefined) lines.push(`Keep it to about ${draw.targetChars} characters${draw.multiline === false ? ", one line" : ""}.`);
  else if (draw.multiline === false) lines.push("Keep it to one line.");
  if (draw.multiline === true) lines.push("You may use a second line.");
  if (draw.question !== undefined) lines.push(draw.question ? "You may ask one short question." : "Do not ask him a question.");
  return lines;
}
