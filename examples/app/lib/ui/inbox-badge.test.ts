import { describe, expect, test } from "vitest";
import { dueNote, inboxBadge, matchesFilter, shortAge } from "./inbox-badge";

const base = { aiEnabled: true, openCreatorHandoff: false, viewer: "creator" } as const;

describe("inboxBadge", () => {
  test("follows mode and the open handoff", () => {
    expect(inboxBadge({ ...base, mode: "ai" })).toBe("AI");
    expect(inboxBadge({ ...base, mode: "ai", aiEnabled: false })).toBe("AI off");
    expect(inboxBadge({ ...base, mode: "handoff_creator", openCreatorHandoff: true })).toBe("Handoff");
    expect(inboxBadge({ ...base, mode: "ai", openCreatorHandoff: true })).toBe("Handoff");
    expect(inboxBadge({ ...base, mode: "human_creator" })).toBe("You");
    expect(inboxBadge({ ...base, mode: "closed" })).toBeNull();
  });
  test("an admin sees T&S on T&S chats and who is answering on the rest", () => {
    expect(inboxBadge({ ...base, viewer: "admin", mode: "handoff_ts" })).toBe("T&S");
    expect(inboxBadge({ ...base, viewer: "admin", mode: "human_ts" })).toBe("T&S");
    expect(inboxBadge({ ...base, viewer: "admin", mode: "human_creator" })).toBe("Juno");
    expect(inboxBadge({ ...base, viewer: "admin", mode: "ai", aiEnabled: true })).toBe("AI");
  });

  test("filters pick the right rows", () => {
    const badges = ["AI", "Handoff", "You", "AI off", null];
    expect(badges.filter((b) => matchesFilter(b, "needs"))).toEqual(["Handoff"]);
    expect(badges.filter((b) => matchesFilter(b, "ai"))).toEqual(["AI"]);
    expect(badges.filter((b) => matchesFilter(b, "all"))).toHaveLength(5);
  });
  test("shortAge", () => {
    expect([0, 59_000, 5 * 60_000, 3 * 3_600_000, 2 * 86_400_000].map(shortAge)).toEqual(["now", "now", "5m", "3h", "2d"]);
  });
});

describe("dueNote", () => {
  const open = { queue: "creator", dueInMs: 12 * 60_000 - 1, openedAgoMs: 0, autoResolves: true, breached: false } as const;
  test("a creator row says when it settles itself, rounded up to a whole minute", () => {
    expect(dueNote(open)).toBe("Auto-resolves in 12 min");
    expect(dueNote({ ...open, dueInMs: 1 })).toBe("Auto-resolves in 1 min");
    expect(dueNote({ ...open, dueInMs: 0 })).toBe("Auto-resolving now");
    expect(dueNote({ ...open, dueInMs: -5000 })).toBe("Auto-resolving now");
  });
  test("a reason a person must handle, or a row with no due time, says nothing", () => {
    expect(dueNote({ ...open, autoResolves: false })).toBeNull();
    expect(dueNote({ ...open, dueInMs: null })).toBeNull();
  });
  test("a Trust & Safety row says how long it has waited and marks a late one", () => {
    const ts = { ...open, queue: "ts", autoResolves: false, openedAgoMs: 20 * 60_000 } as const;
    expect(dueNote(ts)).toBe("Waiting 20m");
    expect(dueNote({ ...ts, breached: true })).toBe("Waiting 20m · late");
  });
});
