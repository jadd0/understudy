import { expect, test } from "vitest";
import { rig, world } from "@understudy/engine/testing";
import { makeQuery } from "./query";
import { getRoutes } from "./routes";

test("turn_committed_by_runTurn_appears_in_routes", async () => {
  const w = await world({ "retrieval.k": 5 }); // the engine's test helper does not seed this row
  const result = await rig().chatter.runTurn(w.conv.id);
  expect(result).toMatchObject({ status: "committed", route: "reply", outcome: "replied" });

  // The window straddles the real clock the turn row was stamped with; the injected `to` is only an upper bound.
  const to = new Date(Date.now() + 10 * 60_000);
  const q = makeQuery({ creatorIds: [w.creator.id], includeTs: false }, { from: new Date(to.getTime() - 3_600_000), to, bucket: "hour" }, to);
  const routes = await getRoutes(q);
  expect(routes.total).toBe(1);
  expect(routes.byRoute).toEqual([{ route: "reply", count: 1 }]);
  expect(routes.byOutcome).toEqual([{ outcome: "replied", count: 1 }]);
});
