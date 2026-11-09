import { describe, expect, test } from "vitest";
import { claudeHistory, gapLabel, gapMarker, isSessionStart, jevLines, lastRounds, sessionGapMs, threadBlock, PAID_LINE, type ChatMessage } from "./thread";

const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);
const min = (n: number) => T0 + n * 60_000;
let n = 0;
const msg = (sender: ChatMessage["sender"], body: string, atMin: number): ChatMessage => ({ id: `m${n++}`, sender, body, createdAt: new Date(min(atMin)) });
const G = 30;

describe("gap labels", () => {
  test("gap_label_minutes_hours_days", () => {
    const cases: [number, string][] = [
      [38 * 60_000, "38 minutes"],
      [60_000, "1 minute"],
      [59 * 60_000 + 59_000, "59 minutes"],
      [60 * 60_000, "1 hour"],
      [5.9 * 3_600_000, "5 hours"],
      [47.9 * 3_600_000, "47 hours"],
      [48 * 3_600_000, "2 days"],
      [100 * 3_600_000, "4 days"],
    ];
    expect(cases.map(([ms]) => gapLabel(ms))).toEqual(cases.map(([, label]) => label));
    expect(gapMarker(38 * 60_000)).toBe("— 38 minutes later —");
  });
});

describe("rounds", () => {
  test("lastRounds cuts at round boundaries and never splits a reply", () => {
    const h = [msg("fan", "a", 0), msg("ai", "a1", 1), msg("ai", "a2", 1), msg("ai", "a3", 1), msg("fan", "b", 2), msg("fan", "b2", 2), msg("ai", "b1", 3), msg("fan", "c", 4)];
    expect(lastRounds(h, 1).map((m) => m.body)).toEqual(["c"]);
    expect(lastRounds(h, 2).map((m) => m.body)).toEqual(["b", "b2", "b1", "c"]);
    expect(lastRounds(h, 3).map((m) => m.body)).toEqual(["a", "a1", "a2", "a3", "b", "b2", "b1", "c"]);
    expect(lastRounds(h, 99)).toHaveLength(h.length);
    expect(lastRounds(h, 0)).toEqual([]);
  });
});

describe("claude history", () => {
  test("claude_markers_only_in_fan_lines", () => {
    const h = [msg("fan", "hi", 0), msg("ai", "hey you", 1), msg("fan", "back", 100), msg("ai", "welcome back", 300), msg("fan", "ok", 301)];
    const out = claudeHistory(h, { rounds: 20, gapMinutes: G });
    expect(out).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hey you" },
      { role: "user", content: "— 1 hour later —\nback" },
      { role: "assistant", content: "welcome back" },
      { role: "user", content: "ok" },
    ]);
    // the 200 minute gap before her reply carries no marker
    expect(out.filter((m) => m.role === "assistant").every((m) => !/later —/.test(m.content))).toBe(true);
    expect(out.filter((m) => m.role === "assistant")).toHaveLength(2);
  });

  test("system_messages_excluded", () => {
    const h = [msg("fan", "hi", 0), msg("system", "You tipped $5.00", 1), msg("ai", "hey", 2), msg("fan", "yo", 3)];
    expect(claudeHistory(h, { rounds: 20, gapMinutes: G }).map((m) => m.content)).toEqual(["hi", "hey", "yo"]);
    const batch = new Set([h[3].id]);
    expect(jevLines(h, batch, { rounds: 6, gapMinutes: G }).map((l) => l.text)).toEqual(["hi", "hey"]);
  });
});

describe("jev lines", () => {
  test("jev_lines_mark_any_sender_gap_and_gap_before_batch", () => {
    const h = [msg("fan", "hi", 0), msg("ai", "hey", 1), msg("fan", "u there", 61), msg("ai", "yes", 200), msg("fan", "heyyy", 240)];
    const lines = jevLines(h, new Set([h[4].id]), { rounds: 6, gapMinutes: G });
    expect(lines).toEqual([
      { from: "fan", text: "hi" },
      { from: "her", text: "hey" },
      { from: "time", text: "— 1 hour later —" },
      { from: "fan", text: "u there" },
      { from: "time", text: "— 2 hours later —" },
      { from: "her", text: "yes" },
      { from: "time", text: "— 40 minutes later —" },
    ]);
  });

  test("no markers below the threshold and no marker when there is no earlier chat", () => {
    const h = [msg("fan", "hi", 0), msg("ai", "hey", 5), msg("fan", "yo", 10)];
    expect(jevLines(h, new Set([h[2].id]), { rounds: 6, gapMinutes: G }).every((l) => l.from !== "time")).toBe(true);
    const first = [msg("fan", "hi", 0)];
    expect(jevLines(first, new Set([first[0].id]), { rounds: 6, gapMinutes: G })).toEqual([]);
  });
});

describe("session start", () => {
  test("session_start_is_her_silence_over_threshold", () => {
    const h = (gap: number) => [msg("fan", "hi", 0), msg("ai", "hey", 1), msg("fan", "yo", 1 + gap)];
    const at = (gap: number) => {
      const x = h(gap);
      return sessionGapMs(x, new Set([x[2].id]), G);
    };
    expect(at(29)).toBeNull();
    expect(at(30)).toBe(30 * 60_000);
    expect(at(37)).toBe(37 * 60_000);
    const x = h(37);
    expect(isSessionStart(x, new Set([x[2].id]), G)).toBe(true);
    // the first exchange of a chat is not a session start
    const first = [msg("fan", "hi", 0)];
    expect(isSessionStart(first, new Set([first[0].id]), G)).toBe(false);
  });
});

describe("thread block", () => {
  test("one line per signal; absent signals are omitted", () => {
    expect(threadBlock("unknown", null)).toBeNull();
    expect(threadBlock("answers_her", null)).toMatch(/^## The chat right now\n- He is answering/);
    expect(threadBlock("unknown", 38 * 60_000)).toBe("## The chat right now\n- He wrote this 38 minutes after your last message.");
    expect(threadBlock("returning", 5 * 3_600_000)!.split("\n")).toHaveLength(3);
  });
});

describe("paid line", () => {
  test("a fan who has unlocked something gets the paid line first; others do not", () => {
    expect(threadBlock("unknown", null, true)).toBe(`## The chat right now\n- ${PAID_LINE}`);
    expect(threadBlock("unknown", null, false)).toBeNull();
  });
});
