/** Whole years between a `YYYY-MM-DD` date of birth and `now`, both read in UTC. */
export function ageOn(dob: string, now: Date): number {
  const [y, m, d] = dob.split("-").map(Number);
  let age = now.getUTCFullYear() - y;
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  if (month < m || (month === m && day < d)) age -= 1;
  return age;
}

export const ADULT_AGE = 18;

/** A 29 February birthday is reached on 1 March in a common year. */
export function isAdult(dob: string, now: Date): boolean {
  return ageOn(dob, now) >= ADULT_AGE;
}

/** Strict `YYYY-MM-DD` that names a real calendar day and is not in the future. */
export function parseDob(input: unknown, now: Date): string | null {
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input)) return null;
  const date = new Date(`${input}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== input) return null;
  if (date.getUTCFullYear() < 1900 || date.getTime() > now.getTime()) return null;
  return input;
}
