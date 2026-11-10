import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import path from "node:path";

// The workspace packages resolve to their TypeScript source, never through their published `exports` (which point
// at `dist`). The same map feeds the tsconfig `paths`.
const sources: Record<string, string> = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "workspace-sources.json"), "utf8"));
const workspaceAliases = Object.entries(sources).map(([name, file]) => ({
  find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`),
  replacement: path.resolve(import.meta.dirname, file),
}));

export default defineConfig({
  resolve: { alias: [{ find: "@", replacement: path.resolve(import.meta.dirname, "examples/app") }, ...workspaceAliases] },
  test: {
    environment: "node",
    include: ["**/*.test.ts"], exclude: ["**/node_modules/**", ".claude/**", "**/.next/**", "**/*.live.test.ts"],
    globalSetup: ["vitest.global-setup.ts"],
    setupFiles: ["vitest.setup.ts"],
    fileParallelism: false,
    server: { deps: { inline: ["next-auth"] } },
    testTimeout: 30000,
    hookTimeout: 120000,
  },
});
