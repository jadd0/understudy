import { describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { makeUser } from "@/db/test-helpers";
import { expectedSeatRole, seatAccountReady } from "@/lib/auth/seat-account";

function env(creator: string, admins: string): NodeJS.ProcessEnv {
  return { SEED_CREATOR_EMAIL: creator, SEED_ADMIN_EMAILS: admins } as unknown as NodeJS.ProcessEnv;
}

describe("seat accounts", () => {
  test("expected role comes from the seed env, case-insensitively", () => {
    const e = env("Juno@Example.com", "a@example.com, b@example.com");
    expect(expectedSeatRole(" juno@example.com", e)).toBe("creator");
    expect(expectedSeatRole("B@example.com", e)).toBe("admin");
    expect(expectedSeatRole("fan@example.com", e)).toBeNull();
  });

  test("a seat with no account yet is not ready (seed has not run)", async () => {
    const email = `seat-${randomUUID()}@example.com`;
    expect(await seatAccountReady(email, env(email, ""))).toBe(false);
  });

  test("a seat whose row has the wrong role is not ready", async () => {
    const email = `seat-${randomUUID()}@example.com`;
    await makeUser({ email, role: "fan" });
    expect(await seatAccountReady(email, env(email, ""))).toBe(false);
  });

  test("a seeded creator seat and admin seat are ready", async () => {
    const creator = `seat-${randomUUID()}@example.com`;
    const admin = `seat-${randomUUID()}@example.com`;
    await makeUser({ email: creator, role: "creator" });
    await makeUser({ email: admin, role: "admin" });
    expect(await seatAccountReady(creator, env(creator, admin))).toBe(true);
    expect(await seatAccountReady(admin, env(creator, admin))).toBe(true);
  });

  test("a flagged seat account is not ready", async () => {
    const email = `seat-${randomUUID()}@example.com`;
    await makeUser({ email, role: "admin", flaggedAt: new Date() });
    expect(await seatAccountReady(email, env("", email))).toBe(false);
  });
});
