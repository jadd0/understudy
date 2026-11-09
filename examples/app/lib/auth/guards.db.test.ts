import { describe, expect, test } from "vitest";
import { readAccessUser, resolveAccess, type Access, type Route } from "@/lib/auth/guards";
import { NOW, makeUser } from "@/db/test-helpers";
import { navLinksFor } from "@/lib/ui/app-nav";

const ROUTES: Route[] = ["chat", "console", "admin"];
const allow: Access = { kind: "allow" };
const nf: Access = { kind: "notFound" };
const to = (p: string): Access => ({ kind: "redirect", to: p });

describe("route guard matrix", () => {
  const cases: { name: string; make: () => Promise<string | null>; expected: Access[] }[] = [
    { name: "signed out", make: async () => null, expected: [to("/signin"), to("/signin"), to("/signin")] },
    {
      name: "flagged fan",
      make: async () => (await makeUser({ flaggedAt: NOW, flagReason: "under_18_declared" })).id,
      expected: [to("/blocked"), to("/blocked"), to("/blocked")],
    },
    {
      name: "fan restricted as a minor in chat",
      make: async () => (await makeUser({ adultConfirmedAt: NOW, flaggedAt: NOW, flagReason: "minor_in_chat" })).id,
      expected: [to("/blocked"), to("/blocked"), to("/blocked")],
    },
    {
      name: "fan who has not confirmed 18+",
      make: async () => (await makeUser()).id,
      expected: [to("/onboarding"), nf, nf],
    },
    {
      name: "confirmed fan",
      make: async () => (await makeUser({ adultConfirmedAt: NOW })).id,
      expected: [allow, nf, nf],
    },
    { name: "creator", make: async () => (await makeUser({ role: "creator" })).id, expected: [nf, allow, nf] },
    // An admin opens the creator console too.
    { name: "admin", make: async () => (await makeUser({ role: "admin" })).id, expected: [nf, allow, allow] },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const id = await c.make();
      const got = await Promise.all(ROUTES.map((r) => resolveAccess(id, r)));
      expect(got).toEqual(c.expected);
    });
  }

  test("an unknown user id is treated as signed out", async () => {
    expect(await resolveAccess("00000000-0000-0000-0000-000000000000", "chat")).toEqual(to("/signin"));
  });

  test("onboarding: unconfirmed fan allowed, confirmed fan sent to chat, creator 404", async () => {
    const fan = await makeUser();
    const done = await makeUser({ adultConfirmedAt: NOW });
    const creator = await makeUser({ role: "creator" });
    expect(await resolveAccess(fan.id, "onboarding")).toEqual(allow);
    expect(await resolveAccess(done.id, "onboarding")).toEqual(to("/chat"));
    expect(await resolveAccess(creator.id, "onboarding")).toEqual(nf);
  });

  test("home sends each role to its own area", async () => {
    const ids = [
      await makeUser({ adultConfirmedAt: NOW }),
      await makeUser({ role: "creator" }),
      await makeUser({ role: "admin" }),
    ];
    const got = await Promise.all(ids.map((u) => resolveAccess(u.id, "home")));
    expect(got).toEqual([to("/chat"), to("/console"), to("/admin")]);
  });

  test("a user flagged after the session was issued is blocked on the next check", async () => {
    const { db } = await import("@/db/client");
    const { users } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const fan = await makeUser({ adultConfirmedAt: NOW });
    expect(await resolveAccess(fan.id, "chat")).toEqual(allow);
    await db.update(users).set({ flaggedAt: NOW }).where(eq(users.id, fan.id));
    expect(await resolveAccess(fan.id, "chat")).toEqual(to("/blocked"));
  });

  test("minor_in_chat_fan_reads_chat_read_only", async () => {
    const fan = await makeUser({ adultConfirmedAt: NOW, flaggedAt: NOW, flagReason: "minor_in_chat" });
    // the read-only door opens, the home redirect lands on it, and every other route stays blocked
    expect(await resolveAccess(fan.id, "chatRead")).toEqual(allow);
    expect(await resolveAccess(fan.id, "home")).toEqual(to("/chat"));
    expect(await resolveAccess(fan.id, "chat")).toEqual(to("/blocked"));
    expect(await resolveAccess(fan.id, "onboarding")).toEqual(to("/blocked"));
    // the under-18 date at onboarding and any other flag still end at /blocked, read-only door included
    for (const reason of ["under_18_declared", "banned by trust and safety", null]) {
      const other = await makeUser({ adultConfirmedAt: NOW, flaggedAt: NOW, flagReason: reason });
      expect(await resolveAccess(other.id, "chatRead")).toEqual(to("/blocked"));
    }
  });

  test("the navigation reads role and flag from the row, so a flag set mid-session empties it at once", async () => {
    const admin = await makeUser({ role: "admin", name: "T&S One" });
    const row = await readAccessUser(admin.id);
    expect(row).toMatchObject({ role: "admin", name: "T&S One", email: admin.email });
    expect(navLinksFor(row).map((l) => l.href)).toEqual(["/admin", "/console", "/admin/sim", "/analytics"]);

    const fan = await makeUser({ adultConfirmedAt: NOW });
    expect(navLinksFor(await readAccessUser(fan.id)).map((l) => l.href)).toEqual(["/chat", "/wallet"]);
    const { db } = await import("@/db/client");
    const { users } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db.update(users).set({ flaggedAt: NOW, flagReason: "banned by trust and safety" }).where(eq(users.id, fan.id));
    expect(navLinksFor(await readAccessUser(fan.id))).toEqual([]);
    expect(await readAccessUser(null)).toBeNull();
  });
});
