import { describe, expect, test } from "vitest";
import type { Snapshot, Thread, ThreadMessage } from "@/lib/conversations/read";
import { groupMessages, type ChatRow } from "@/lib/ui/group-messages";
import {
  applyChanges,
  mergeOlder,
  mergeSnapshot,
  reconcilePending,
  upsertMessages,
  type PendingMessage,
} from "@/lib/ui/thread-window";

const t = (min: number) => new Date(Date.UTC(2026, 10, 4, 12, min)).toISOString();

function msg(id: string, min: number, over: Partial<ThreadMessage> = {}): ThreadMessage {
  return { id, sender: "ai", body: id, at: t(min), ageMs: 0, clientMsgId: null, offer: null, ...over };
}

const meta: Omit<Thread, "messages"> = {
  conversation: {
    id: "c1",
    mode: "ai",
    aiEnabled: true,
    fanName: "Fan",
    creatorName: "Juno",
    creatorImage: null,
    creatorId: "cr1",
    fanId: "f1",
    fanRestricted: false,
  },
  pendingMs: [],
  aiPending: false,
  handoff: null,
};

const snap = (messages: ThreadMessage[], over: Partial<Snapshot> = {}): Snapshot => ({
  thread: { ...meta, messages },
  suggested: null,
  labels: {},
  ...over,
});

const ids = (ms: readonly ThreadMessage[]) => ms.map((m) => m.id);

describe("mergeOlder", () => {
  test("prepends an older page, oldest first", () => {
    const merged = mergeOlder([msg("c", 3), msg("d", 4)], [msg("a", 1), msg("b", 2)]);
    expect(ids(merged)).toEqual(["a", "b", "c", "d"]);
  });

  test("an overlapping page adds nothing twice, and the held copy wins", () => {
    const held = msg("c", 3, { body: "held" });
    const merged = mergeOlder([held, msg("d", 4)], [msg("b", 2), msg("c", 3, { body: "stale" })]);
    expect(ids(merged)).toEqual(["b", "c", "d"]);
    expect(merged[1].body).toBe("held");
  });

  test("a page holding nothing new returns the same array", () => {
    const current = [msg("a", 1)];
    expect(mergeOlder(current, [msg("a", 1)])).toBe(current);
  });

  test("equal times order by id", () => {
    expect(ids(mergeOlder([msg("b", 1)], [msg("c", 1), msg("a", 1)]))).toEqual(["a", "b", "c"]);
  });
});

describe("upsertMessages / applyChanges", () => {
  test("an upsert replaces an offer's state in place and appends new messages", () => {
    const offer = { id: "o1", title: "Set", teaser: "t", priceCents: 500, state: "locked" as const };
    const before = snap([msg("a", 1), msg("b", 2, { offer })], { labels: { a: "reply" } });
    const after = applyChanges(before, {
      upserts: [msg("b", 2, { offer: { ...offer, state: "unlocked" } }), msg("c", 3)],
      thread: { ...meta, conversation: { ...meta.conversation, mode: "human_creator" }, pendingMs: [900] },
      suggested: { id: "s1", body: "hi" },
      labels: { c: "offer" },
    });
    expect(ids(after.thread.messages)).toEqual(["a", "b", "c"]);
    expect(after.thread.messages[1].offer?.state).toBe("unlocked");
    expect(after.thread.conversation.mode).toBe("human_creator");
    expect(after.thread.pendingMs).toEqual([900]);
    expect(after.suggested).toEqual({ id: "s1", body: "hi" });
    expect(after.labels).toEqual({ a: "reply", c: "offer" });
  });

  test("an upsert that lands earlier than held messages is re-sorted", () => {
    expect(ids(upsertMessages([msg("a", 1), msg("c", 3)], [msg("b", 2)]))).toEqual(["a", "b", "c"]);
  });

  test("an overlapping change read is harmless", () => {
    const current = [msg("a", 1), msg("b", 2)];
    expect(ids(upsertMessages(current, [msg("a", 1), msg("b", 2)]))).toEqual(["a", "b"]);
  });

  test("a whole snapshot merges into loaded history instead of replacing it", () => {
    const loaded = snap([msg("a", 1), msg("b", 2), msg("c", 3)]);
    const merged = mergeSnapshot(loaded, snap([msg("c", 3), msg("d", 4)]));
    expect(ids(merged.thread.messages)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("reconcilePending", () => {
  const p = (id: string, afterSeq?: number): PendingMessage => ({ id, text: id, at: 0, afterSeq });

  test("a pending bubble goes when its message comes back by clientMsgId", () => {
    const kept = reconcilePending([p("x"), p("y")], [msg("m1", 1, { sender: "fan", clientMsgId: "x" })], 1);
    expect(kept.map((x) => x.id)).toEqual(["y"]);
  });

  test("an acknowledged send goes with any read that started after it", () => {
    expect(reconcilePending([p("x", 3)], [], 3).map((x) => x.id)).toEqual(["x"]);
    expect(reconcilePending([p("x", 3)], [], 4)).toEqual([]);
  });

  test("nothing confirmed returns the same array", () => {
    const pending = [p("x")];
    expect(reconcilePending(pending, [], 9)).toBe(pending);
  });
});

describe("grouping over the merged list", () => {
  test("a run split across a page boundary joins up", () => {
    const toInput = (m: ThreadMessage) => ({ id: m.id, side: "them" as const, text: m.body, at: new Date(m.at) });
    const merged = mergeOlder([msg("c", 3), msg("d", 4)], [msg("a", 1), msg("b", 2)]);
    const rows = groupMessages(merged.map(toInput), new Date(t(10))).filter(
      (r): r is Extract<ChatRow, { kind: "message" }> => r.kind === "message",
    );
    expect(rows.map((r) => [r.key, r.first, r.last, r.showAvatar])).toEqual([
      ["a", true, false, false],
      ["b", false, false, false],
      ["c", false, false, false],
      ["d", false, true, true],
    ]);
  });
});
