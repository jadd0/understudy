import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "@/db/client";
import { turns } from "@/db/schema";
import { makeAdmin, makeConversation, makeCreator, makeFan } from "@/lib/conversations/test-helpers";

const session = { current: null as { user: { id: string } } | null };
vi.mock("@/lib/auth", () => ({ auth: async () => session.current }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { turnsPageAction } = await import("./actions");
const { PAGE_SIZE } = await import("@/lib/analytics/turns");
const as = (id: string | null) => void (session.current = id ? { user: { id } } : null);

// 23 turns one minute apart, newest first is ids[0]. A second creator's turns must never appear.
let creatorUserId: string;
let ids: string[];
let otherIds: string[];
beforeAll(async () => {
  const creator = await makeCreator();
  creatorUserId = creator.userId;
  const conv = await makeConversation(creator.id, (await makeFan()).id);
  const base = Date.now() - 3_600_000;
  const rows = await db
    .insert(turns)
    .values(Array.from({ length: 23 }, (_, i) => ({ conversationId: conv.id, createdAt: new Date(base + i * 60_000), route: "reply" as const, outcome: "replied" })))
    .returning({ id: turns.id, createdAt: turns.createdAt });
  ids = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map((r) => r.id);
  const other = await makeCreator();
  const otherConv = await makeConversation(other.id, (await makeFan()).id);
  otherIds = (await db.insert(turns).values({ conversationId: otherConv.id, createdAt: new Date(base), outcome: "replied" }).returning({ id: turns.id })).map((r) => r.id);
});

beforeEach(() => as(null));

describe("turnsPageAction", () => {
  test("pages hold 10 rows", () => {
    expect(PAGE_SIZE).toBe(10);
  });

  test("page 2 returns rows 11 to 20 of the viewer's own turns", async () => {
    as(creatorUserId);
    const p = await turnsPageAction({ range: "24h", page: 2 });
    expect(p).toMatchObject({ total: 23, page: 2, pages: 3 });
    expect(p!.rows.map((r) => r.id)).toEqual(ids.slice(10, 20));
    const last = await turnsPageAction({ range: "24h", page: 3 });
    expect(last!.rows.map((r) => r.id)).toEqual(ids.slice(20));
    expect(last!.rows.some((r) => otherIds.includes(r.id))).toBe(false);
  });

  test("filters apply to the paged fetch, and a page past the end clamps to the last", async () => {
    as(creatorUserId);
    expect((await turnsPageAction({ range: "24h", route: "offer", page: 2 }))).toMatchObject({ total: 0, page: 1, rows: [] });
    expect((await turnsPageAction({ range: "24h", page: 99 }))!.page).toBe(3);
  });

  test("an admin may page too", async () => {
    as((await makeAdmin()).id);
    expect(await turnsPageAction({ range: "24h", page: 1 })).not.toBeNull();
  });

  test("a fan, a signed-out visitor and an unknown user are refused", async () => {
    as((await makeFan()).id);
    expect(await turnsPageAction({ range: "24h", page: 2 })).toBeNull();
    as(null);
    expect(await turnsPageAction({ range: "24h", page: 2 })).toBeNull();
    as("00000000-0000-0000-0000-000000000000");
    expect(await turnsPageAction({ range: "24h", page: 2 })).toBeNull();
  });
});
