import { describe, expect, test } from "vitest";
import { inboxBadge, matchesFilter, shortAge } from "./inbox-badge";

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
