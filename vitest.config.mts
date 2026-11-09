import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "examples/app") } },
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
