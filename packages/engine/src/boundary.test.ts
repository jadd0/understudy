import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = process.cwd();
const PKG = "packages/engine/src";

// Everything the package may take from the app. The package owns no connection or tables of its own yet,
// so it reads them through the app's database client and schema, and its tunables through `getConfig`.
const ALLOWED_APP_IMPORTS = ["@/db/client", "@/db/schema", "@/lib/config"];

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

// Test support (tests, the `test-*` helpers and the in-memory host) reaches the app's database, seed and
// providers to build a world; it is not part of the package's runtime surface.
const isTestSupport = (f: string) => /\.test\.tsx?$/.test(f) || /(^|\/)test-[^/]+\.ts$/.test(f) || f.endsWith("/fake-host.ts") || f.endsWith("/testing.ts");

describe("the engine package boundary", () => {
  test("the package imports from the app only @/db/client, @/db/schema and @/lib/config", () => {
    const files = walk(PKG).filter((f) => !isTestSupport(f));
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain(`${PKG}/turn.ts`);
    expect(files).toContain(`${PKG}/index.ts`);
    expect(files).not.toContain(`${PKG}/test-harness.ts`);
    const offenders: string[] = [];
    let appImports = 0;
    for (const f of files) {
      for (const spec of specifiersOf(readFileSync(join(ROOT, f), "utf8"))) {
        if (spec.startsWith("@/")) {
          appImports++;
          if (!ALLOWED_APP_IMPORTS.includes(spec)) offenders.push(`${f}: ${spec}`);
        } else if (spec.startsWith(".")) {
          // A relative path that climbs out of the package is an app import by another name.
          const target = relative(ROOT, join(ROOT, f, "..", spec));
          if (!target.startsWith(PKG)) offenders.push(`${f}: ${spec}`);
        }
      }
    }
    expect(appImports).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  test("nothing outside the package imports a deep path inside it", () => {
    const files = ["app", "lib", "scripts", "providers", "components", "db"].flatMap((d) => walk(d));
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    let viaEntry = 0;
    for (const f of files) {
      for (const spec of specifiersOf(readFileSync(join(ROOT, f), "utf8"))) {
        if (spec === "@understudy/engine" || spec === "@understudy/engine/testing") viaEntry++;
        else if (spec.startsWith("@understudy/engine/") || spec.includes("packages/engine")) offenders.push(`${f}: ${spec}`);
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
    expect(["lib/engine", "lib/persona", "platform/ports", "providers/fake"].filter(exists)).toEqual([]);
  });
});
