/**
 * A date and clock time the way the wallet lists them ("4 Nov, 17:24"), in the viewer's own timezone, as the chat
 * shows its clock times. `timeZone` is for tests; in the browser it is left unset, so the viewer's zone applies.
 */
export function dayAndTime(at: Date, timeZone?: string): string {
  return at.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone });
}
