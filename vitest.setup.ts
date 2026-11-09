// @ts-expect-error -- plain ESM script without types
import { useLocalNeon } from "./scripts/neon-local.mjs";

// Each test worker opens its own pools: point the driver at the local proxy when the test database is local, which
// vitest.global-setup.ts makes it.
useLocalNeon(process.env.DATABASE_URL);
