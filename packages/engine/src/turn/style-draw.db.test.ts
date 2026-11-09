import { asc, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { messages, personaCards, turns } from "@/db/schema";
import { runTurn } from "./run";
import { seededRandom } from "../testing/rng";
import { isMemoryCall, rig, world } from "../testing/harness";

const RATES = { n: 100, pet: "biscuit", signoff_x: 0, mate: 0, babe: 0, pet_name: 0, emoji: 0, concrete_fact: 0.1 };

async function setMarkers(creatorId: string, markers: Record<string, unknown> | null) {
  await db.update(personaCards).set({ markers }).where(eq(personaCards.creatorId, creatorId));
}
const sentBodies = async (conversationId: string) =>
  (await db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt), asc(messages.id)))
    .filter((m) => m.sender === "ai")
    .map((m) => m.body);
const replyCalls = (r: ReturnType<typeof rig>) => r.generator.calls.filter((c) => !isMemoryCall(c));

describe("the style draw in a turn", () => {
  test("a sign-off and an address term the draw did not allow never reach the fan, and the prompt says so", async () => {
    const w = await world();
    await setMarkers(w.creator.id, RATES);
    const r = rig({ replies: ["ha proper tired mate x"] });
    r.deps.random = seededRandom(1);
    await runTurn(r.ctx, w.conv.id);
    expect(await sentBodies(w.conv.id)).toEqual(["ha proper tired"]);
    const turn = replyCalls(r)[0].system.turn;
    expect(turn).toContain("## Voice for this reply");
    expect(turn).toContain("No sign-off");
    expect(turn).toContain("Do not mention Biscuit");
    const [t] = await db.select().from(turns).where(eq(turns.conversationId, w.conv.id));
    expect(t.jevOut).toMatchObject([{ style: { signoff: false, address: null, petName: false, emoji: false } }, { attempt: 1, failures: [] }]);
  });

  test("a draw that allows the markers leaves the reply alone", async () => {
    const w = await world();
    await setMarkers(w.creator.id, { ...RATES, signoff_x: 1, mate: 1, pet_name: 1, emoji: 1 });
    const r = rig({ replies: ["ha proper tired mate x"] });
    r.deps.random = seededRandom(1);
    await runTurn(r.ctx, w.conv.id);
    expect(await sentBodies(w.conv.id)).toEqual(["ha proper tired mate x"]);
  });

  test("with no stored rates the prompt and the reply are as before", async () => {
    const w = await world();
    await setMarkers(w.creator.id, null);
    const r = rig({ replies: ["ha proper tired mate x"] });
    await runTurn(r.ctx, w.conv.id);
    expect(await sentBodies(w.conv.id)).toEqual(["ha proper tired mate x"]);
    expect(replyCalls(r)[0].system.turn).not.toContain("Voice for this reply");
    const [t] = await db.select().from(turns).where(eq(turns.conversationId, w.conv.id));
    expect(JSON.stringify(t.jevOut)).not.toContain("style");
  });

  test("a fan who says her pet's name makes it allowed", async () => {
    const w = await world({}, "is biscuit with you?");
    await setMarkers(w.creator.id, RATES);
    const r = rig();
    r.deps.random = seededRandom(1);
    await runTurn(r.ctx, w.conv.id);
    expect(replyCalls(r)[0].system.turn).toContain("You may mention Biscuit");
  });
});
