import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = process.cwd();
const PKG = "packages/providers/src";

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

const sourceFiles = () => walk(PKG).filter((f) => !/\.test\.tsx?$/.test(f));

describe("the providers package boundary", () => {
  test("the providers package imports nothing from the app", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain(`${PKG}/index.ts`);
    expect(files).toContain(`${PKG}/failover/generator.ts`);
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
    expect(specifiers).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });

  test("it reaches the engine only through @understudy/engine and @understudy/engine/schema", () => {
    const files = sourceFiles();
    const offenders: string[] = [];
    let viaEntry = 0;
    for (const f of files) {
      for (const spec of specifiersOf(readFileSync(join(ROOT, f), "utf8"))) {
        if (spec === "@understudy/engine" || spec === "@understudy/engine/schema") viaEntry++;
        else if (spec.startsWith("@understudy/engine/") || spec.includes("packages/engine")) offenders.push(`${f}: ${spec}`);
      }
    }
    expect(viaEntry).toBeGreaterThan(5);
    expect(offenders).toEqual([]);
  });

  test("nothing outside the package imports a deep path inside it", () => {
    const files = ["app", "lib", "scripts", "providers", "components", "db", "packages/engine/src", "packages/persona/src"].flatMap((d) => walk(d));
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    let viaEntry = 0;
    for (const f of files) {
      for (const spec of specifiersOf(readFileSync(join(ROOT, f), "utf8"))) {
        if (spec === "@understudy/providers") viaEntry++;
        else if (spec.startsWith("@understudy/providers/") || spec.includes("packages/providers")) offenders.push(`${f}: ${spec}`);
        else if (spec.startsWith(".") && relative(ROOT, join(ROOT, f, "..", spec)).startsWith("packages/providers")) offenders.push(`${f}: ${spec}`);
      }
    }
    expect(viaEntry).toBeGreaterThan(5);
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
    expect(["anthropic", "typesafe", "failover", "pg", "voyage", "noop"].map((d) => `providers/${d}`).filter(exists)).toEqual([]);
    expect(readdirSync(join(ROOT, "providers")).sort()).toEqual(["pusher", "stripe.ts"]);
  });
});
