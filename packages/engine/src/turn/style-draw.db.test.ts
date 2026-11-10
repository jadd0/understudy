import { asc, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { messages, personaCards, turns } from "@/db/schema";
import { runTurn } from "./run.js";
import { seededRandom } from "../testing/rng.js";
import { isMemoryCall, rig, world } from "../testing/harness.js";

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

describe("the draw's length, line, emoji and pet limits in a turn", () => {
  const SHAPED = { ...RATES, length_chars: { p25: 20, p50: 20, p75: 20, p90: 20 }, multiline: 0, question: 0 };
  const LONG = "honestly babe i have been up since five with Biscuit barking at every single bird outside the window 😂\nand now i am shattered";

  test("a long two-line reply with an emoji and the pet is retried with the reasons, and the short second draft is sent as one line", async () => {
    const w = await world();
    await setMarkers(w.creator.id, SHAPED);
    const r = rig({ replies: [LONG, "ha proper tired 😂"] });
    r.deps.random = seededRandom(1);
    await runTurn(r.ctx, w.conv.id);
    const calls = replyCalls(r);
    expect(calls).toHaveLength(2);
    expect(calls[0].system.turn).toMatch(/Keep it to about \d+ characters, one line\./);
    expect(calls[0].system.turn).toContain("Do not ask him a question.");
    expect(calls[1].system.turn).toContain("## Retry");
    expect(calls[1].system.turn).toMatch(/Shorter: one line, about \d+ characters\./);
    expect(calls[1].system.turn).toContain("Do not mention Biscuit.");
    expect(calls[1].system.turn).not.toContain("rejected by a safety check");
    expect(await sentBodies(w.conv.id)).toEqual(["ha proper tired"]);
    const [t] = await db.select().from(turns).where(eq(turns.conversationId, w.conv.id));
    expect(t.jevOut).toMatchObject([{ style: {} }, { attempt: 1, failures: ["too_long", "pet_disallowed"] }, { attempt: 2, failures: [] }]);
  });

  test("when the retry is long too it is still sent, cleaned to one line with no emoji, after exactly two attempts", async () => {
    const w = await world();
    await setMarkers(w.creator.id, SHAPED);
    const r = rig({ replies: [LONG, LONG] });
    r.deps.random = seededRandom(1);
    await runTurn(r.ctx, w.conv.id);
    expect(replyCalls(r)).toHaveLength(2);
    const [body] = await sentBodies(w.conv.id);
    expect(body).toBe("honestly babe i have been up since five with Biscuit barking at every single bird outside the window and now i am shattered");
  });

  test("a reply that is only an emoji is sent, never emptied", async () => {
    const w = await world();
    await setMarkers(w.creator.id, SHAPED);
    const r = rig({ replies: ["🐕"] });
    r.deps.random = seededRandom(1);
    await runTurn(r.ctx, w.conv.id);
    expect(await sentBodies(w.conv.id)).toEqual(["🐕"]);
  });

  test("markers without the length keys draw none of it: no length line, no retry on a long reply", async () => {
    const w = await world();
    await setMarkers(w.creator.id, RATES);
    const r = rig({ replies: ["a perfectly ordinary and rather long reply that goes on well past her usual forty characters"] });
    r.deps.random = seededRandom(1);
    await runTurn(r.ctx, w.conv.id);
    expect(replyCalls(r)).toHaveLength(1);
    expect(replyCalls(r)[0].system.turn).not.toMatch(/about \d+ characters|second line|Do not ask him a question|ask one short question/);
    expect(await sentBodies(w.conv.id)).toHaveLength(1);
  });
});
