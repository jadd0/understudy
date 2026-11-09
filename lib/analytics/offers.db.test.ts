import { beforeAll, describe, expect, test } from "vitest";
import { buildWorld } from "./fixtures";
import { fund, makeConversation, makeCreator, makeFan, makeItem, makeOffer, setConfig } from "@/lib/wallet/test-helpers";
import { unlockOffer } from "@/lib/wallet/unlock";
import { getOfferFunnel } from "./offers";
import { makeQuery } from "./query";
import { parseRange } from "./range";

let w: Awaited<ReturnType<typeof buildWorld>>;
beforeAll(async () => {
  w = await buildWorld();
});

describe("getOfferFunnel", () => {
  test("offer_funnel_unlocked_only_after_offer", async () => {
    const f = await getOfferFunnel(w.q);
    // o1 converted. o5 (another fan unlocked the item) and o6 (unlocked before the offer) are not.
    expect(f).toMatchObject({ made: 6, unlocked: 1, declined: 3, expired: 2, stillOpen: 0 });
    expect(f.acceptanceRate).toBeCloseTo(1 / 6, 10);
    expect(f.offerTurns).toBe(2);
    expect(f.replyTurns).toBe(4);
    expect(f.offerRate).toBe(0.5);
  });

  test("funnel_parts_add_up", async () => {
    const f = await getOfferFunnel(w.q);
    expect(f.unlocked + f.declined + f.expired + f.stillOpen).toBe(f.made);
  });
});

describe("getOfferFunnel with a re-purchase", () => {
  test("a re-offer of an item he already owned, bought again, counts as converted", async () => {
    await setConfig();
    const fan = await makeFan();
    const creator = await makeCreator();
    const item = await makeItem(creator.id, 999);
    const conv = await makeConversation(creator.id, fan.id);
    await fund(fan.id, 3000);
    await unlockOffer(fan.id, (await makeOffer(conv.id, item.id, 999)).id);
    // The second purchase keeps the first `unlocks` row, which predates this offer: only its ledger entry credits it.
    await unlockOffer(fan.id, (await makeOffer(conv.id, item.id, 999)).id);
    const now = new Date(Date.now() + 1000);
    const f = await getOfferFunnel(makeQuery({ creatorIds: [creator.id], includeTs: false }, parseRange("7d", now), now));
    expect(f).toMatchObject({ made: 2, unlocked: 2, declined: 0, expired: 0, stillOpen: 0 });
  });
});
