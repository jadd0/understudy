export const RANGES = ["24h", "7d", "30d"] as const;
export type RangeKey = (typeof RANGES)[number];
export type Bucket = "hour" | "day";

export interface Range {
  key: RangeKey;
  from: Date;
  to: Date;
  bucket: Bucket;
}

const HOUR = 3_600_000;
const SPAN_MS: Record<RangeKey, number> = { "24h": 24 * HOUR, "7d": 7 * 24 * HOUR, "30d": 30 * 24 * HOUR };

export class BadRange extends Error {
  constructor(value: unknown) {
    super(`unknown range: ${String(value)}`);
    this.name = "BadRange";
  }
}

export function isRangeKey(v: unknown): v is RangeKey {
  return typeof v === "string" && (RANGES as readonly string[]).includes(v);
}

/** The window ends at `now` (injected, never read here) and is bucketed hourly for a day, daily beyond that. */
export function parseRange(key: unknown, now: Date): Range {
  if (!isRangeKey(key)) throw new BadRange(key);
  return { key, from: new Date(now.getTime() - SPAN_MS[key]), to: now, bucket: key === "24h" ? "hour" : "day" };
}

/** Start of the UTC hour or day containing `d`. */
export function bucketStart(d: Date, bucket: Bucket): Date {
  const step = bucket === "hour" ? HOUR : 24 * HOUR;
  return new Date(Math.floor(d.getTime() / step) * step);
}

/** Every bucket start from the one containing `from` through the one containing `to`, so empty buckets still plot. */
export function bucketStarts(from: Date, to: Date, bucket: Bucket): number[] {
  const step = bucket === "hour" ? HOUR : 24 * HOUR;
  const out: number[] = [];
  for (let t = bucketStart(from, bucket).getTime(); t <= to.getTime(); t += step) out.push(t);
  return out;
}
