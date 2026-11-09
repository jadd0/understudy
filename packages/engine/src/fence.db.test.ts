import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { fanMemory, offers, personaCards } from "@/db/schema";
import { TypeSafeDecider } from "@/providers/typesafe/decider";
import { addMessage } from "./test-db";
import { rig, world } from "./test-harness";
import { runTurn } from "./turn";

const CARD_SENTINEL = "ZEBRA-CARD-SENTINEL";
const MEMORY_SENTINEL = "kayak-sentinel";

/** Answers every Jev question the harmless way, and keeps every request body it was sent. */
function capturingFetch() {
  const bodies: string[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    const raw = String(init.body);
    bodies.push(raw);
    const { questions } = JSON.parse(raw) as { questions: Record<string, { criteria: Record<string, string> }> };
    const fixed: Record<string, string> = { intent: "smalltalk", explicitness: "none", on_persona: "yes", offer_pick: "o1", offer_response: "na", thread: "same_topic", pitch_fit: "yes", reasks: "no", leads_to_offer: "yes" };
    const answers = Object.fromEntries(
      Object.entries(questions).map(([key, q]) => {
        const options = Object.keys(q.criteria);
        const choice = fixed[key] ?? (options.includes("no") ? "no" : options[0]);
        return [key, { type: "choice", choice, probabilities: { [choice]: 0.97 }, confidence: 0.97 }];
      }),
    );
    return new Response(JSON.stringify({ model: "jev-1.14.0", answers, usage: { input_tokens: 50, output_tokens: 0 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { bodies, impl };
}

describe("the Jev input fence", () => {
  test("no persona card, price or fan memory ever appears in a request to Jev", async () => {
    const w = await world({ "pitch.min_gap_rounds": 0 });
    await db.update(personaCards).set({ body: `You are Juno. ${CARD_SENTINEL}. Lowercase and warm.` }).where(eq(personaCards.creatorId, w.creator.id));
    await db.insert(fanMemory).values({ creatorId: w.creator.id, fanId: w.fan.id, profile: { name: "Dan", interests: [MEMORY_SENTINEL], dislikes: [] } });

    const wire = capturingFetch();
    const r = rig();
    r.deps.decider = new TypeSafeDecider({ apiKey: "k", model: "jev-1.14.0", timeoutMs: 5000, backoffMs: 1, fetch: wire.impl });

    expect(await runTurn(r.ctx, w.conv.id)).toMatchObject({ route: "offer", outcome: "replied" });
    await addMessage(w.conv.id, "fan", "what else do you have?");
    await runTurn(r.ctx, w.conv.id);

    // inbound classification, offer pick and draft verification all went through the real adapter
    expect(wire.bodies.length).toBeGreaterThanOrEqual(3);
    const questionKeys = wire.bodies.flatMap((b) => Object.keys(JSON.parse(b).questions));
    expect(questionKeys).toEqual(expect.arrayContaining(["intent", "offer_pick", "on_persona"]));
    const pick = wire.bodies.find((b) => b.includes("offer_pick"))!;
    expect(pick).toContain("Golden hour");

    // the chat so far reaches both Jev calls that read it (classification and verification), as plain lines
    const inbound = wire.bodies.find((b) => b.includes('"thread"'))!;
    const verify = wire.bodies.filter((b) => b.includes("on_persona")).at(-1)!;
    expect(inbound).toContain("earlier_messages");
    expect(verify).toContain("earlier_messages");
    expect(verify).toContain("what else do you have?");

    for (const body of wire.bodies) {
      for (const secret of [CARD_SENTINEL, MEMORY_SENTINEL, "Dan", "1777", "17.77", "2888", "28.88", "my ex"]) {
        expect(body, secret).not.toContain(secret);
      }
    }

    // control: the model that writes the reply does see the card and the memory, so the absence above means something
    const system = r.generator.calls[0].system;
    expect(system.cached).toContain(CARD_SENTINEL);
    expect(system.turn).toContain(MEMORY_SENTINEL);
    expect((await db.select().from(offers).where(eq(offers.conversationId, w.conv.id))).length).toBeGreaterThan(0);
  });
});
