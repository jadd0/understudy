import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

// The demo creator's name, handle, site and photo path. The app serves any creator, so none of it may appear in what
// renders (or in a comment beside it) outside the seed, the sim, the evals and the fixtures, which are her data.
const DEMO_CREATOR = /\bjuno\b|junovale|biscuit|creators\/juno/i;

const APP = join(__dirname, "..");
const ROOTS = ["app", "components", "lib/ui"].map((d) => join(APP, d));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function hits(text: string): number[] {
  return text.split("\n").flatMap((line, i) => (DEMO_CREATOR.test(line) ? [i + 1] : []));
}

describe("no hardcoded creator", () => {
  test("no demo creator name, handle or photo path in app, components or lib/ui", () => {
    const files = ROOTS.flatMap(sources);
    // a walk that finds nothing would pass for the wrong reason
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith("app/chat/actions.ts"))).toBe(true);
    const found = files.flatMap((f) => hits(readFileSync(f, "utf8")).map((n) => `${relative(APP, f)}:${n}`));
    expect(found).toEqual([]);
  });

  test("the matcher bites: the name, the handle, the photo path and the pet are caught, other words are not", () => {
    expect(hits('placeholder="Message Juno…"')).toEqual([1]);
    expect(hits("a\nhandle junovale\nb\nsrc=/creators/juno/a.jpg")).toEqual([2, 4]);
    expect(hits("her pet Biscuit")).toEqual([1]);
    expect(hits("Junior, junction, Mira")).toEqual([]);
  });
});
