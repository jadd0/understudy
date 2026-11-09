import { beforeAll, expect, test } from "vitest";
import { buildWorld } from "./fixtures";
import { getResponsible } from "./responsible";

let w: Awaited<ReturnType<typeof buildWorld>>;
beforeAll(async () => {
  w = await buildWorld();
});

test("responsible_counts_hardship_block", async () => {
  const r = await getResponsible(w.q);
  // t7 (reply, p 0.9) and t10 (offer, p 0.8) are at or above the 0.5 floor; t10 pitched anyway.
  expect(r).toEqual({ hardshipTurns: 2, pitchedDespiteHardship: 1, hardshipCooldownsActive: 1, fansAtCapToday: 1 });
});

test("the_ten_day_old_and_other_creator_rows_do_not_leak_in", async () => {
  expect((await getResponsible(w.adminQ)).hardshipTurns).toBe(2);
});
