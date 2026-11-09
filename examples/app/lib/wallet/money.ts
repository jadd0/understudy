/**
 * Dollars as a person types them ("12", "12.5", "12.50") to whole cents. Anything else is refused with null
 * rather than rounded into something plausible: no signs, no exponent, no third decimal.
 */
export function dollarsToCents(input: string): number | null {
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
