import { describe, expect, test } from "vitest";
import { groupMessages, type ChatRow } from "@/lib/ui/group-messages";

const at = (h: number, m: number) => new Date(2026, 10, 3, h, m);
const now = at(15, 0);
const msgs = (rows: ChatRow[]) => rows.filter((r) => r.kind === "message") as Extract<ChatRow, { kind: "message" }>[];

describe("groupMessages", () => {
  test("a run from one side: first/last flags, avatar only on the last 'them' bubble", () => {
    const rows = groupMessages(
      [
        { id: "1", side: "them", text: "a", at: at(14, 0) },
        { id: "2", side: "them", text: "b", at: at(14, 1) },
        { id: "3", side: "me", text: "c", at: at(14, 2) },
      ],
      now,
    );
    const m = msgs(rows);
    expect(m.map((r) => [r.first, r.last, r.showAvatar])).toEqual([
      [true, false, false],
      [false, true, true],
      [true, true, false],
    ]);
  });

  test("a support message is its own speaker: it splits the creator's run and never gets her avatar", () => {
    const rows = groupMessages(
      [
        { id: "1", side: "them", text: "juno", at: at(14, 0) },
        { id: "2", side: "them", text: "support a", at: at(14, 1), support: true },
        { id: "3", side: "them", text: "support b", at: at(14, 2), support: true },
        { id: "4", side: "them", text: "juno again", at: at(14, 3) },
      ],
      now,
    );
    expect(msgs(rows).map((r) => [r.support, r.first, r.last, r.showAvatar])).toEqual([
      [false, true, true, true],
      [true, true, false, false],
      [true, false, true, false],
      [false, true, true, true],
    ]);
  });

  test("a gap of 30 minutes inserts a separator and splits the run", () => {
    const rows = groupMessages(
      [
        { id: "1", side: "me", text: "a", at: at(14, 0) },
        { id: "2", side: "me", text: "b", at: at(14, 30) },
      ],
      now,
    );
    expect(rows.map((r) => r.kind)).toEqual(["separator", "message", "separator", "message"]);
    expect(msgs(rows).every((r) => r.first && r.last)).toBe(true);
  });

  test("today's separator reads 'Today HH:MM'", () => {
    const rows = groupMessages([{ id: "1", side: "them", text: "a", at: at(14, 2) }], now);
    expect(rows[0]).toMatchObject({ kind: "separator", label: "Today 14:02" });
  });

  test("a system notice stands alone and splits the runs around it", () => {
    const at = new Date("2026-11-03T10:00:00Z");
    const rows = groupMessages(
      [
        { id: "1", side: "them", text: "a", at },
        { id: "2", side: "system", text: "notice", at },
        { id: "3", side: "system", text: "notice 2", at },
        { id: "4", side: "them", text: "b", at },
      ],
      at,
    ).filter((r) => r.kind === "message");
    expect(rows.map((r) => (r.kind === "message" ? [r.side, r.first, r.last, r.showAvatar] : null))).toEqual([
      ["them", true, true, true],
      ["system", true, true, false],
      ["system", true, true, false],
      ["them", true, true, true],
    ]);
  });

  test("each message row carries its clock time", () => {
    const rows = groupMessages([{ id: "1", side: "me", text: "a", at: at(9, 5) }], now);
    expect(msgs(rows).map((r) => r.time)).toEqual(["09:05"]);
  });

  test("a later separator on the same day is the time alone; the first names the day", () => {
    const rows = groupMessages(
      [
        { id: "1", side: "me", text: "a", at: at(12, 0) },
        { id: "2", side: "them", text: "b", at: at(13, 0) },
        { id: "3", side: "me", text: "c", at: at(14, 5) },
      ],
      now,
    );
    const labels = rows.filter((r) => r.kind === "separator").map((r) => r.label);
    expect(labels).toEqual(["Today 12:00", "13:00", "14:05"]);
  });

  test("a new day names the day again", () => {
    const yesterday = new Date(2026, 10, 2, 23, 0);
    const rows = groupMessages(
      [
        { id: "1", side: "me", text: "a", at: yesterday },
        { id: "2", side: "me", text: "b", at: at(9, 0) },
      ],
      now,
    );
    expect(rows.filter((r) => r.kind === "separator").map((r) => r.label)).toEqual(["Mon 2 Nov 23:00", "Today 09:00"]);
  });

  test("a tip row keeps its amount and stands alone", () => {
    const rows = groupMessages(
      [
        { id: "1", side: "me", text: "a", at: at(14, 0) },
        { id: "2", side: "system", text: "You tipped $5.00", at: at(14, 1), tip: "$5.00" },
        { id: "3", side: "me", text: "b", at: at(14, 2) },
      ],
      now,
    );
    expect(msgs(rows).map((r) => [r.side, r.tip, r.first, r.last])).toEqual([
      ["me", undefined, true, true],
      ["system", "$5.00", true, true],
      ["me", undefined, true, true],
    ]);
  });
});
