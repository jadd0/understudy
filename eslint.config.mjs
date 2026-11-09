import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  { settings: { next: { rootDir: "examples/app" } } },
  globalIgnores(["**/.next/**", "**/out/**", "**/build/**", "**/next-env.d.ts", ".claude/**", "**/drizzle/**", "gate-logs/**"]),
]);
