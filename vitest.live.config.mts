import { defineConfig } from "vitest/config";
import path from "node:path";
import { workspaceAliases } from "./vitest.workspace-aliases.mjs";

// Opt-in tests that call real providers (LIVE=1 npm run test:live). The gate's config excludes `*.live.test.ts`.
export default defineConfig({
  resolve: { alias: [{ find: "@", replacement: path.resolve(import.meta.dirname, "examples/app") }, ...workspaceAliases(import.meta.dirname)] },
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
