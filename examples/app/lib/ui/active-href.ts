// Kept apart from app-nav.ts so the client link list can import it without pulling the server-only guards into the browser.
export type NavLink = { readonly href: string; readonly label: string };

/** The link the current path sits under: the longest href that equals the path or is a parent of it. */
export function activeHref(links: readonly NavLink[], pathname: string): string | null {
  let best: string | null = null;
  for (const { href } of links) {
    const under = pathname === href || pathname.startsWith(`${href}/`);
    if (under && (!best || href.length > best.length)) best = href;
  }
  return best;
}
