import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { workspaceAliases } from "./vitest.workspace-aliases.mjs";

const root = import.meta.dirname;
const sources: Record<string, string> = JSON.parse(readFileSync(path.join(root, "workspace-sources.json"), "utf8"));

describe("the workspace aliases", () => {
  test("every entry of workspace-sources.json is an exact-match alias to a file that exists", () => {
    const aliases = workspaceAliases(root);
    expect(aliases.length).toBeGreaterThanOrEqual(5);
    expect(aliases.map((a) => a.replacement).sort()).toEqual(Object.values(sources).map((f) => path.join(root, f)).sort());
    for (const a of aliases) expect(existsSync(a.replacement)).toBe(true);
    const engine = aliases.find((a) => a.find.test("@jadd0/understudy-engine"));
    expect(engine?.replacement).toBe(path.join(root, sources["@jadd0/understudy-engine"]));
    // The bare package name must not swallow a subpath.
    expect(engine?.find.test("@jadd0/understudy-engine/schema")).toBe(false);
  });

  test("both vitest configs take them from this module and read no sources map of their own", () => {
    for (const file of ["vitest.config.mts", "vitest.live.config.mts"]) {
      const text = readFileSync(path.join(root, file), "utf8");
      expect(text).toContain('from "./vitest.workspace-aliases.mjs"');
      expect(text).not.toContain("workspace-sources.json");
    }
  });
});
