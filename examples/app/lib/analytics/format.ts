// Render-time formatting only: every stored figure stays an integer (cents, micro-dollars, milliseconds).
export const DASH = "—";

export function usd(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return DASH;
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

/** Micro-dollars: 4 decimals under a cent so a $0.0004 reply is not shown as $0.00. */
export function usdMicros(micros: number | null | undefined): string {
  if (micros === null || micros === undefined || !Number.isFinite(micros)) return DASH;
  const dollars = micros / 1_000_000;
  return `$${dollars.toFixed(Math.abs(dollars) < 0.01 ? 4 : 2)}`;
}

export function pct(r: number | null | undefined): string {
  return r === null || r === undefined || !Number.isFinite(r) ? DASH : `${(r * 100).toFixed(1)}%`;
}

export function ms(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
}

export function seconds(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  if (v < 90) return `${Math.round(v)} s`;
  if (v < 5400) return `${(v / 60).toFixed(1)} min`;
  return `${(v / 3600).toFixed(1)} h`;
}

export function count(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? DASH : n.toLocaleString("en-US");
}
