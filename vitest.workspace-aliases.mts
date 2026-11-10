import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The workspace packages resolve to their TypeScript source in tests, never through their published `exports` (which
 * point at `dist`). The same `workspace-sources.json` feeds the tsconfig `paths`.
 */
export function workspaceAliases(root: string): { find: RegExp; replacement: string }[] {
  const sources: Record<string, string> = JSON.parse(readFileSync(path.resolve(root, "workspace-sources.json"), "utf8"));
  return Object.entries(sources).map(([name, file]) => ({
    find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`),
    replacement: path.resolve(root, file),
  }));
}
