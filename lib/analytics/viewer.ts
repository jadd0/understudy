import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { resolveAccess, type Access } from "@/lib/auth/guards";
import { analyticsScope, type Scope } from "./scope";

export interface AnalyticsViewer {
  userId: string;
  scope: Scope;
  isAdmin: boolean;
}

/** The session viewer and their scope, or the access decision that refuses them. Role read fresh from the user row. */
async function resolveViewer(): Promise<{ viewer: AnalyticsViewer } | { refused: Exclude<Access, { kind: "allow" }> }> {
  const session = await auth();
  const userId = session?.user?.id;
  // Admin first: the console route also admits admins, and an admin must keep the admin scope.
  for (const route of ["admin", "console"] as const) {
    const access = await resolveAccess(userId, route);
    if (access.kind === "redirect") return { refused: access };
    if (access.kind === "allow") return { viewer: { userId: userId!, scope: await analyticsScope(userId!), isAdmin: route === "admin" } };
  }
  return { refused: { kind: "notFound" } };
}

/** Creators and admins only. Signed out goes to sign-in, a flagged account to /blocked, any other role gets a 404. */
export async function requireAnalyticsViewer(): Promise<AnalyticsViewer> {
  const r = await resolveViewer();
  if ("viewer" in r) return r.viewer;
  if (r.refused.kind === "redirect") redirect(r.refused.to);
  notFound();
}

/** The same decision for a data request (a server action): null instead of a redirect or a 404. */
export async function analyticsViewerOrNull(): Promise<AnalyticsViewer | null> {
  const r = await resolveViewer();
  return "viewer" in r ? r.viewer : null;
}
