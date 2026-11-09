/**
 * Demo-seat sign-in hands the browser the Auth.js callback link through a page, not a server-action redirect.
 *
 * Why: a server action that calls `redirect()` to a same-site URL has Next.js follow it on the server, inside the same
 * request. Auth.js then creates the session and sets the cookie on that internal request, and the browser never gets
 * it. Sending the browser to /signin/continue, which navigates to the callback itself, puts the cookie where
 * it belongs.
 */

const CALLBACK_PREFIX = "/api/auth/callback/resend?";

/** The path of the handoff page for an Auth.js callback link (absolute or relative). */
export function seatHandoffPath(link: string): string {
  const url = new URL(link, "http://placeholder.invalid");
  return `/signin/continue?to=${encodeURIComponent(url.pathname + url.search)}`;
}

/** The callback path to navigate to, or null when `to` is anything but this site's Resend sign-in callback. */
export function safeCallbackPath(to: string | null | undefined): string | null {
  if (typeof to !== "string" || !to.startsWith(CALLBACK_PREFIX)) return null;
  // Reject anything that would leave the site or the callback route once a browser resolves it.
  if (to.includes("//") || to.includes("\\") || to.includes("#")) return null;
  const url = new URL(to, "http://placeholder.invalid");
  if (url.origin !== "http://placeholder.invalid" || `${url.pathname}?` !== CALLBACK_PREFIX) return null;
  return url.pathname + url.search;
}
