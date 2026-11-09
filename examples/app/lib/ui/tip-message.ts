/**
 * A tip leaves a system row in the thread ("You tipped $5.00", written by the tip action). The chat design
 * draws that row as a yellow card instead of a notice; this recognises it and returns the amount as shown.
 */
const TIP_ROW = /^You tipped (\$\d[\d,]*(?:\.\d{2})?)$/;

export function parseTipMessage(sender: string, body: string): { amount: string } | null {
  if (sender !== "system") return null;
  const m = TIP_ROW.exec(body);
  return m ? { amount: m[1] } : null;
}

/** An amount the way the tip UI shows it: whole dollars without cents ("$10"), otherwise "$2.50". */
export function tipLabel(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}
