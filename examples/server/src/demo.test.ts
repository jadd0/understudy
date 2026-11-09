import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { runDemo } from "./demo";
import { SERVER_DIR } from "./seed";

describe("the demo", () => {
  test("--fake plays the script against the test database and prints a reply per line, the takeover and the hand-back", async () => {
    const lines: string[] = [];
    const script = readFileSync(path.join(SERVER_DIR, "demo-script.txt"), "utf8").split("\n").filter((l) => l.trim());
    const result = await runDemo({ fake: true, fast: true, takeoverAfter: 6, out: (l) => lines.push(l) });

    expect(script.length).toBeGreaterThanOrEqual(8);
    expect(result.fanLines).toBe(script.length);
    expect(result.repliesPerLine).toHaveLength(script.length);
    expect(result.repliesPerLine.every((n) => n >= 1)).toBe(true);
    for (const line of script) expect(lines).toContain(`fan> ${line}`);
    const takeover = lines.findIndex((l) => l.startsWith("== TAKEOVER"));
    const handBack = lines.findIndex((l) => l.startsWith("== HAND-BACK"));
    expect(takeover).toBeGreaterThan(0);
    expect(handBack).toBeGreaterThan(takeover);
    // Her own words sit between the two markers, and an offer card was shown.
    expect(lines.slice(takeover, handBack).some((l) => l.trim().startsWith("creator") && l.includes("juno"))).toBe(true);
    expect(lines.some((l) => l.includes("offer: Golden hour at 9.99"))).toBe(true);
  }, 90_000);
});
