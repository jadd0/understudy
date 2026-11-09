import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { auth } from "@/lib/auth";

export type Role = "fan" | "creator" | "admin";
export type Route = "home" | "onboarding" | "chat" | "chatRead" | "console" | "admin";
export type Access = { kind: "allow" } | { kind: "redirect"; to: string } | { kind: "notFound" };

export type AccessUser = { role: Role; flaggedAt: Date | null; adultConfirmedAt: Date | null; flagReason?: string | null };

/** The flag reason of a fan restricted for showing they are a minor in chat: they may read the chat, nothing else. */
export const MINOR_IN_CHAT = "minor_in_chat";

const ROLE_HOME: Record<Role, string> = { fan: "/chat", creator: "/console", admin: "/admin" };
// The roles each guarded route admits. An admin opens the creator console too; a fan never does.
const ROUTE_ROLES: Record<Exclude<Route, "home" | "onboarding">, readonly Role[]> = {
  chat: ["fan"],
  chatRead: ["fan"],
  console: ["creator", "admin"],
  admin: ["admin"],
};

const allow: Access = { kind: "allow" };
const go = (to: string): Access => ({ kind: "redirect", to });

export const isRestrictedFan = (u: AccessUser) => u.role === "fan" && Boolean(u.flaggedAt) && u.flagReason === MINOR_IN_CHAT;

/** Where a signed-in user belongs. Order matters: sign-in, flag, onboarding, role home. */
export function homeFor(user: AccessUser | null): string {
  if (!user) return "/signin";
  if (user.flaggedAt) return isRestrictedFan(user) ? "/chat" : "/blocked";
  if (user.role === "fan" && !user.adultConfirmedAt) return "/onboarding";
  return ROLE_HOME[user.role];
}

/** The pure access decision. A wrong role gets 404, never a redirect that hints a route exists. */
export function decideAccess(user: AccessUser | null, route: Route): Access {
  if (!user) return go("/signin");
  // A restricted fan reads their chat history and nothing else; every other route stays blocked.
  if (user.flaggedAt && route === "chatRead" && isRestrictedFan(user)) return allow;
  if (user.flaggedAt && route === "home" && isRestrictedFan(user)) return go("/chat");
  if (user.flaggedAt) return go("/blocked");
  if (route === "home") return go(homeFor(user));
  if (route === "onboarding") {
    if (user.role !== "fan") return { kind: "notFound" };
    return user.adultConfirmedAt ? go("/chat") : allow;
  }
  if (!ROUTE_ROLES[route].includes(user.role)) return { kind: "notFound" };
  if (user.role === "fan" && !user.adultConfirmedAt) return go("/onboarding");
  return allow;
}

/** Reads the user row fresh, so a flag set after the session was issued still blocks. */
export async function resolveAccess(userId: string | null | undefined, route: Route): Promise<Access> {
  return decideAccess(await readAccessUser(userId), route);
}

/** The user row the access decision reads, plus the name, email and photo shown as "signed in as". Null when signed out or gone. */
export async function readAccessUser(
  userId: string | null | undefined,
): Promise<(AccessUser & { name: string | null; email: string | null; image: string | null }) | null> {
  if (!userId) return null;
  const [row] = await db
    .select({
      role: users.role,
      flaggedAt: users.flaggedAt,
      adultConfirmedAt: users.adultConfirmedAt,
      flagReason: users.flagReason,
      name: users.name,
      email: users.email,
      image: users.image,
    })
    .from(users)
    .where(eq(users.id, userId));
  return row ?? null;
}

/** The session user plus the role read fresh from the user row, never the role the session carried. */
async function enforce(route: Route) {
  const session = await auth();
  const row = await readAccessUser(session?.user?.id);
  const access = decideAccess(row, route);
  if (access.kind === "redirect") redirect(access.to);
  if (access.kind === "notFound") notFound();
  return { ...session!.user, id: session!.user!.id!, role: row!.role };
}

/** Server components and actions: only `role` may pass; a fan must also have confirmed 18+. */
export async function requireRole(role: Role) {
  const user = await enforce(role === "fan" ? "chat" : role === "creator" ? "console" : "admin");
  // The console route also admits admins; requireRole("creator") stays the creator alone.
  if (user.role !== role) notFound();
  return user;
}

/** The creator console: the creator, or an admin. The returned role is the user row's. */
export async function requireConsole() {
  const user = await enforce("console");
  return { ...user, role: user.role as "creator" | "admin" };
}

export function requireAdultFan() {
  return enforce("chat");
}

/** The chat page and its refresh: also open, read-only, to a fan restricted as a minor in chat. */
export function requireChatReader() {
  return enforce("chatRead");
}

export function requireOnboarding() {
  return enforce("onboarding");
}

export function redirectHome() {
  return enforce("home");
}
