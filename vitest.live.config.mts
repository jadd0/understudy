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

// Opt-in tests that call real providers (LIVE=1 npm run test:live). The gate's config excludes `*.live.test.ts`.
export default defineConfig({
  resolve: { alias: [{ find: "@", replacement: path.resolve(import.meta.dirname, "examples/app") }, ...workspaceAliases] },
  test: {
    environment: "node",
    include: ["**/*.live.test.ts"],
    exclude: ["**/node_modules/**", ".claude/**", "**/.next/**"],
    globalSetup: ["vitest.global-setup.ts"],
    fileParallelism: false,
    testTimeout: 180000,
    hookTimeout: 120000,
  },
});
