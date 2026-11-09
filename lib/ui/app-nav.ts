import { isRestrictedFan, type AccessUser } from "@/lib/auth/guards";
import type { NavLink } from "./active-href";

export type { NavLink };

const FAN: readonly NavLink[] = [
  { href: "/chat", label: "Chat" },
  { href: "/wallet", label: "Wallet" },
];
const CREATOR: readonly NavLink[] = [
  { href: "/console", label: "Inbox" },
  { href: "/console/settings", label: "Settings" },
  { href: "/analytics", label: "Analytics" },
];
// An admin opens the creator console too, besides its own queue at /admin.
const ADMIN: readonly NavLink[] = [
  { href: "/admin", label: "Safety queue" },
  { href: "/console", label: "Console" },
  { href: "/admin/sim", label: "Simulator" },
  { href: "/analytics", label: "Analytics" },
];

/**
 * The top navigation for a signed-in user, from the user row (never from anything the client sends).
 * Only routes the guard would let this user open: a fan restricted as a minor in chat keeps Chat alone,
 * and a blocked account or a fan who has not confirmed 18+ gets no links.
 */
export function navLinksFor(user: AccessUser | null): readonly NavLink[] {
  if (!user) return [];
  if (user.flaggedAt) return isRestrictedFan(user) ? FAN.slice(0, 1) : [];
  if (user.role === "fan") return user.adultConfirmedAt ? FAN : [];
  return user.role === "creator" ? CREATOR : ADMIN;
}
