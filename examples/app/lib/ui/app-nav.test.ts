import { describe, expect, test } from "vitest";
import { decideAccess, MINOR_IN_CHAT, type AccessUser, type Route } from "@/lib/auth/guards";
import { navLinksFor } from "./app-nav";

const at = new Date("2026-11-01T00:00:00.000Z");
const fan: AccessUser = { role: "fan", flaggedAt: null, adultConfirmedAt: at };
const creator: AccessUser = { role: "creator", flaggedAt: null, adultConfirmedAt: null };
const admin: AccessUser = { role: "admin", flaggedAt: null, adultConfirmedAt: null };

const hrefs = (u: AccessUser | null) => navLinksFor(u).map((l) => l.href);

/** The guard routes each page enforces. /analytics admits a creator or an admin (lib/analytics/viewer.ts). */
function guardRoutes(href: string): Route[] {
  if (href === "/chat") return ["chatRead"];
  if (href === "/wallet") return ["chat"];
  if (href.startsWith("/console")) return ["console"];
  if (href.startsWith("/admin")) return ["admin"];
  if (href === "/analytics") return ["console", "admin"];
  throw new Error(`no guard mapped for ${href}`);
}

describe("navLinksFor", () => {
  test("each role gets its own sections", () => {
    expect(hrefs(fan)).toEqual(["/chat", "/wallet"]);
    expect(hrefs(creator)).toEqual(["/console", "/console/settings", "/analytics"]);
    expect(hrefs(admin)).toEqual(["/admin", "/console", "/admin/sim", "/analytics"]);
  });

  test("an admin is offered the creator console; a fan never is", () => {
    expect(hrefs(admin)).toContain("/console");
    expect(hrefs(fan).some((h) => h.startsWith("/console"))).toBe(false);
    expect(decideAccess(fan, "console")).toEqual({ kind: "notFound" });
  });

  test("signed out, unconfirmed or blocked users get no links; a fan restricted in chat keeps Chat only", () => {
    expect(hrefs(null)).toEqual([]);
    expect(hrefs({ ...fan, adultConfirmedAt: null })).toEqual([]);
    expect(hrefs({ ...creator, flaggedAt: at })).toEqual([]);
    expect(hrefs({ ...fan, flaggedAt: at, flagReason: "under_18" })).toEqual([]);
    expect(hrefs({ ...fan, flaggedAt: at, flagReason: MINOR_IN_CHAT })).toEqual(["/chat"]);
  });

  test("every link a user is shown is one the guard lets that user open", () => {
    const users: AccessUser[] = [fan, creator, admin, { ...fan, flaggedAt: at, flagReason: MINOR_IN_CHAT }];
    for (const u of users) {
      for (const href of hrefs(u)) {
        const allowed = guardRoutes(href).some((r) => decideAccess(u, r).kind === "allow");
        expect(allowed, `${u.role} -> ${href}`).toBe(true);
      }
    }
  });
});
