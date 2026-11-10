import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "@/db/client";
import { conversations, messages, offers } from "@/db/schema";
import { ensureCreator } from "@/scripts/persona/init";
import { addItem } from "@/lib/conversations/controls";
import { listInbox } from "@/lib/conversations/read";
import { asViewer, makeConversation, makeCreator, makeFan } from "@/lib/conversations/test-helpers";
import { addMessage, makeItem, makePersona, rig, setEngineConfig, YES } from "@jadd0/understudy-engine/testing";

const session = { current: null as { user: { id: string } } | null };
// The action stores through the production wiring and schedules the engine with `after`; here the engine is the fake-provider rig,
// and the scheduled work is held until the test runs it.
const engine = { rig: null as ReturnType<typeof rig> | null };
const scheduled: (() => Promise<unknown>)[] = [];
vi.mock("@/lib/auth", () => ({ auth: async () => session.current }));
vi.mock("@/lib/conversations/events", () => ({ getEvents: () => ({ emit: async () => {} }) }));
vi.mock("@/lib/host/deps", () => ({ understudy: async () => engine.rig!.understudy }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (task: () => Promise<unknown>) => void scheduled.push(task) }));

const { sendMessage } = await import("@/app/chat/actions");

beforeEach(() => {
  session.current = null;
  scheduled.length = 0;
  engine.rig = rig({ script: { offer_pick: "o1", pitch_fit: YES } });
});

/** Runs what the action scheduled after its response. */
const runScheduled = async () => {
  const tasks = scheduled.splice(0);
  expect(tasks).toHaveLength(1);
  await tasks[0]();
};

const aiRows = (conversationId: string) =>
  db.select().from(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.sender, "ai"), eq(messages.status, "sent")));

describe("a second creator onboarded the way `init` does it", () => {
  test("her fan reaches her by handle, the engine replies there, her console is hers alone, and the item she adds is what an offer turn pitches", async () => {
    await setEngineConfig({ "pitch.min_gap_rounds": 0, "engine.debounce_ms": 0 });

    // The first creator, with a conversation of her own and an item the second creator's fans must never be offered.
    const first = await makeCreator();
    await makePersona(first.id);
    const firstItem = await makeItem(first.id, { title: "First creator's item", priceCents: 500 });
    const firstFan = await makeFan();
    const firstConv = await makeConversation(first.id, firstFan.id);
    await addMessage(firstConv.id, "fan", "hi there", { ageSeconds: 30 });

    // The second creator is created by `init`'s own creation step and publishes a card, as `--publish` does.
    const handle = `w${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const email = `${randomUUID()}@creator.test`;
    const made = await db.transaction((tx) => ensureCreator(tx, { email, handle, displayName: "Wren" }));
    await makePersona(made.creatorId);
    const viewer = asViewer({ id: made.userId, role: "creator" });

    // A fan writes to her at ?c=<handle>; the message lands in a conversation with her.
    const fan = await makeFan();
    session.current = { user: { id: fan.id } };
    expect(await sendMessage(handle.toUpperCase(), randomUUID(), "hey, how are you?")).toEqual({ ok: true });
    const [conv] = await db.select().from(conversations).where(eq(conversations.fanId, fan.id));
    expect(conv.creatorId).toBe(made.creatorId);

    // The engine, on fake providers, answers in that conversation. She has no catalogue yet, so it is a plain reply.
    await runScheduled();
    expect(await aiRows(conv.id)).toHaveLength(1);
    expect(await db.select().from(offers).where(eq(offers.conversationId, conv.id))).toHaveLength(0);

    // Her console scope holds her conversation and not the first creator's, and the first creator's holds only hers.
    const inbox = await listInbox(viewer);
    expect(inbox.map((row) => row.id)).toEqual([conv.id]);
    const firstInbox = await listInbox(asViewer({ id: first.userId, role: "creator" }));
    expect(firstInbox.map((row) => row.id)).toEqual([firstConv.id]);

    // She adds an item; the next turn pitches it, never the first creator's.
    const itemId = await addItem(viewer, { kind: "ppv", title: "Pier at dawn", teaser: "first light", cents: 1500 });
    session.current = { user: { id: fan.id } };
    expect(await sendMessage(handle, randomUUID(), "what else you got?")).toEqual({ ok: true });
    await runScheduled();
    const pitched = await db.select().from(offers).where(eq(offers.conversationId, conv.id));
    expect(pitched).toMatchObject([{ itemId, priceCents: 1500, status: "open" }]);
    expect(pitched.some((o) => o.itemId === firstItem.id)).toBe(false);
  });
});
