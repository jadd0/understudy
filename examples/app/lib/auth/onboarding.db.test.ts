import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { ledgerEntries, sessions, users } from "@/db/schema";
import { applyOnboarding } from "@/lib/auth/onboarding";
import { NOW, makeUser } from "@/db/test-helpers";
import { assertBalanceEqualsLedger, balanceOf, setConfig } from "@/lib/wallet/test-helpers";

beforeAll(() => setConfig());
const ledger = (id: string) => db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, id));

const row = async (id: string) => (await db.select().from(users).where(eq(users.id, id)))[0];

describe("applyOnboarding (NOW = 2026-11-03 UTC)", () => {
  test("17 years 364 days flags the account, ends its sessions and blocks", async () => {
    const u = await makeUser();
    await db.insert(sessions).values({ sessionToken: `t-${u.id}`, userId: u.id, expires: new Date(NOW.getTime() + 864e5) });
    const res = await applyOnboarding(u.id, { dob: "2008-11-04", adult: true }, NOW);
    expect(res).toEqual({ status: "blocked" });
    const after = await row(u.id);
    expect(after.flaggedAt).toEqual(NOW);
    expect(after.flagReason).toBe("under_18_declared");
    expect(after.adultConfirmedAt).toBeNull();
    expect(await db.select().from(sessions).where(eq(sessions.userId, u.id))).toHaveLength(0);
  });

  test("18 years 0 days confirms", async () => {
    const u = await makeUser();
    expect(await applyOnboarding(u.id, { dob: "2008-11-03", adult: true }, NOW)).toEqual({ status: "confirmed" });
    const after = await row(u.id);
    expect(after.adultConfirmedAt).toEqual(NOW);
    expect(after.dob).toBe("2008-11-03");
    expect(after.flaggedAt).toBeNull();
  });

  test("an unticked box is a form error and writes nothing", async () => {
    const u = await makeUser();
    expect(await applyOnboarding(u.id, { dob: "1990-01-01", adult: false }, NOW)).toEqual({ status: "unconfirmed" });
    const after = await row(u.id);
    expect([after.dob, after.adultConfirmedAt, after.flaggedAt]).toEqual([null, null, null]);
  });

  test("an under-18 date flags even with the box unticked", async () => {
    const u = await makeUser();
    expect(await applyOnboarding(u.id, { dob: "2015-01-01", adult: false }, NOW)).toEqual({ status: "blocked" });
    expect((await row(u.id)).flaggedAt).toEqual(NOW);
  });

  test("an invalid date writes nothing", async () => {
    const u = await makeUser();
    expect(await applyOnboarding(u.id, { dob: "2008-02-30", adult: true }, NOW)).toEqual({ status: "invalid_dob" });
    expect((await row(u.id)).dob).toBeNull();
  });

  test("a resubmit does not change dob or the confirmation time", async () => {
    const u = await makeUser();
    await applyOnboarding(u.id, { dob: "1990-01-01", adult: true }, NOW);
    const later = new Date(NOW.getTime() + 36e5);
    expect(await applyOnboarding(u.id, { dob: "1985-05-05", adult: true }, later)).toEqual({ status: "unchanged" });
    const after = await row(u.id);
    expect(after.dob).toBe("1990-01-01");
    expect(after.adultConfirmedAt).toEqual(NOW);
  });

  test("an adult resubmit after an under-18 submit stays flagged", async () => {
    const u = await makeUser();
    await applyOnboarding(u.id, { dob: "2012-06-06", adult: true }, NOW);
    expect(await applyOnboarding(u.id, { dob: "1990-01-01", adult: true }, NOW)).toEqual({ status: "unchanged" });
    const after = await row(u.id);
    expect(after.flaggedAt).toEqual(NOW);
    expect(after.adultConfirmedAt).toBeNull();
    expect(after.dob).toBe("2012-06-06");
  });

  test("a creator account cannot be onboarded as a fan", async () => {
    const u = await makeUser({ role: "creator" });
    expect(await applyOnboarding(u.id, { dob: "1990-01-01", adult: true }, NOW)).toEqual({ status: "unchanged" });
    expect((await row(u.id)).dob).toBeNull();
  });

  test("an adult confirmation grants the welcome credit once; a resubmit does not grant again", async () => {
    const u = await makeUser();
    expect(await applyOnboarding(u.id, { dob: "1990-01-01", adult: true }, NOW)).toEqual({ status: "confirmed" });
    expect(await applyOnboarding(u.id, { dob: "1990-01-01", adult: true }, NOW)).toEqual({ status: "unchanged" });
    const rows = await ledger(u.id);
    expect(rows.map((r) => [r.kind, r.amountCents])).toEqual([["grant", 5000]]);
    expect(await balanceOf(u.id)).toBe(5000);
    await assertBalanceEqualsLedger(u.id);
  });

  test("an under-18 submit and an unticked box grant nothing", async () => {
    const minor = await makeUser();
    const unticked = await makeUser();
    await applyOnboarding(minor.id, { dob: "2012-06-06", adult: true }, NOW);
    await applyOnboarding(unticked.id, { dob: "1990-01-01", adult: false }, NOW);
    expect(await ledger(minor.id)).toHaveLength(0);
    expect(await ledger(unticked.id)).toHaveLength(0);
    expect(await balanceOf(minor.id)).toBe(0);
  });

  test("a creator account is not granted anything", async () => {
    const u = await makeUser({ role: "creator" });
    await applyOnboarding(u.id, { dob: "1990-01-01", adult: true }, NOW);
    expect(await ledger(u.id)).toHaveLength(0);
  });
});
