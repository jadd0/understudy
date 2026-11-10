import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { makeConversation, makeCreator, makeFan } from "@jadd0/understudy-engine/testing";
import { offers } from "@jadd0/understudy-engine/schema";
import { readCatalogue, ServerHost } from "./host";
import path from "node:path";
import { SERVER_DIR } from "./seed";

describe("ServerHost shortlist", () => {
  let items: ReturnType<typeof readCatalogue>;
  beforeAll(() => {
    items = readCatalogue(path.join(SERVER_DIR, "catalogue.json"));
  });

  test("an open offer's item is not shortlisted, an expired one is", async () => {
    const creator = await makeCreator();
    const fan = await makeFan();
    const conv = await makeConversation(creator.id, fan.id);
    const owned = items.map((i) => ({ ...i, creatorId: creator.id }));
    const host = new ServerHost(db as never, owned, 20000);
    const q = { creatorId: creator.id, fanId: fan.id, conversationId: conv.id, kinds: ["ppv" as const] };

    const before = await host.catalogue.shortlist(q);
    expect(before.map((i) => i.title)).toEqual(["Golden hour", "Lazy Sunday", "Night out"]);

    const golden = owned.find((i) => i.title === "Golden hour")!;
    await db.insert(offers).values({ conversationId: conv.id, itemId: golden.id, priceCents: golden.priceCents, expiresAt: sql`now() + interval '1 hour'` });
    expect((await host.catalogue.shortlist(q)).map((i) => i.title)).toEqual(["Lazy Sunday", "Night out"]);

    const lazy = owned.find((i) => i.title === "Lazy Sunday")!;
    await db.insert(offers).values({ conversationId: conv.id, itemId: lazy.id, priceCents: lazy.priceCents, expiresAt: sql`now() - interval '1 minute'` });
    expect((await host.catalogue.shortlist(q)).map((i) => i.title)).toEqual(["Lazy Sunday", "Night out"]);

    // Another creator's items, kinds outside the filter, and owned lists are never offered.
    expect((await host.catalogue.shortlist({ ...q, creatorId: crypto.randomUUID() })).length).toBe(0);
    expect((await host.catalogue.shortlist({ ...q, kinds: ["bundle"] })).map((i) => i.title)).toEqual(["The full set"]);
    expect(await host.catalogue.ownedShortlist(q)).toEqual([]);
    expect(await host.owns(fan.id, owned.map((i) => i.id))).toEqual(new Set());
  });
});
