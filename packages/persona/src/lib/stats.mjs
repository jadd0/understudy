// Small statistics for the persona evals: Wilson interval, mean, score histogram, reply length buckets.
// Pure functions, no I/O.

const round = (n, places = 4) => Math.round(n * 10 ** places) / 10 ** places;

/** 95% Wilson score interval for `successes` out of `n`; null when n is 0. */
export function wilson(successes, n, z = 1.96) {
  if (!Number.isInteger(n) || n <= 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lower: round(Math.max(0, centre - half)), upper: round(Math.min(1, centre + half)) };
}

/** Mean of a list of numbers, rounded to 4 places; null for an empty list. */
export function mean(values) {
  return values.length ? round(values.reduce((sum, v) => sum + v, 0) / values.length) : null;
}

/** Count of each integer from `min` to `max`; a value outside the range or not an integer throws. */
export function histogram(values, min = 1, max = 5) {
  const counts = Object.fromEntries(Array.from({ length: max - min + 1 }, (_, i) => [String(min + i), 0]));
  for (const v of values) {
    if (!Number.isInteger(v) || v < min || v > max) throw new RangeError(`score outside ${min}-${max}`);
    counts[String(v)]++;
  }
  return counts;
}

export const LENGTH_BUCKETS = ["<=10", "11-30", ">30"];

/** Bucket by character count: up to 10, 11 to 30, more than 30. */
export function lengthBucket(text) {
  const length = [...text].length;
  return length <= 10 ? "<=10" : length <= 30 ? "11-30" : ">30";
}
