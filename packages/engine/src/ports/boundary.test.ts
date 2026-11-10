import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = process.cwd();
const PKG = "packages/engine/src";

const walk = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name === ".next" || e.name === ".claude" || e.name.startsWith(".")) return [];
    const rel = join(dir, e.name);
    if (e.isDirectory()) return walk(rel);
    return /\.(ts|tsx|mts)$/.test(e.name) ? [rel] : [];
  });

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Module specifiers a file imports, re-exports, dynamically imports or mocks. */
const specifiersOf = (src: string): string[] =>
  [...stripComments(src).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bvi\.(?:mock|doMock)\s*\(\s*|^\s*import\s+)"([^"]+)"/gm)].map((m) => m[1]);

// Test support (tests, the `testing/` helpers and the in-memory host) reaches the app's database, seed and
// providers to build a world; it is not part of the package's runtime surface.
const isTestSupport = (f: string) => /\.test\.tsx?$/.test(f) || /(^|\/)testing\/(?!fakes\/)[^/]+\.ts$/.test(f) || f.endsWith("/testing.ts");

describe("the engine package boundary", () => {
  test("the package imports nothing from the app", () => {
    const files = walk(PKG).filter((f) => !isTestSupport(f));
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain(`${PKG}/turn/run.ts`);
    expect(files).toContain(`${PKG}/index.ts`);
    expect(files).not.toContain(`${PKG}/testing/harness.ts`);
    const offenders: string[] = [];
    let specifiers = 0;
    for (const f of files) {
      for (const spec of specifiersOf(readFileSync(join(ROOT, f), "utf8"))) {
        specifiers++;
        if (spec.startsWith("@/")) {
          offenders.push(`${f}: ${spec}`);
        } else if (spec.startsWith(".")) {
          // A relative path that climbs out of the package is an app import by another name.
          const target = relative(ROOT, join(ROOT, f, "..", spec));
          if (!target.startsWith(PKG)) offenders.push(`${f}: ${spec}`);
        }
      }
    }
    expect(specifiers).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });

  test("nothing outside the package imports a deep path inside it", () => {
    const files = ["scripts", "examples", "packages/providers/src"].flatMap((d) => walk(d));
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    let viaEntry = 0;
    for (const f of files) {
      for (const spec of specifiersOf(readFileSync(join(ROOT, f), "utf8"))) {
        if (spec === "@jadd0/understudy-engine" || spec === "@jadd0/understudy-engine/testing" || spec === "@jadd0/understudy-engine/schema" || spec === "@jadd0/understudy-engine/fakes") viaEntry++;
        else if (spec.startsWith("@jadd0/understudy-engine/") || spec.includes("packages/engine")) offenders.push(`${f}: ${spec}`);
        else if (spec.startsWith(".") && relative(ROOT, join(ROOT, f, "..", spec)).startsWith("packages/engine")) offenders.push(`${f}: ${spec}`);
      }
    }
    expect(viaEntry).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });

  test("the old homes are gone", () => {
    const exists = (p: string) => {
      try {
        readdirSync(join(ROOT, p));
        return true;
      } catch {
        return false;
      }
    };
    expect(["lib/engine", "lib/persona", "platform/ports", "providers/fake", "examples/app/lib/engine", "examples/app/lib/persona", "examples/app/providers/fake", "app", "components", "db", "lib", "providers"].filter(exists)).toEqual([]);
  });
});
