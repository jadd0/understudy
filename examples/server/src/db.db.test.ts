import { neonConfig } from "@neondatabase/serverless";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { connect } from "./db";

// The test setup points the global driver config at the local proxy; with it cleared, only the per-pool settings
// can reach the local database.
let saved: typeof neonConfig.opts;
beforeEach(() => {
  saved = neonConfig.opts;
  neonConfig.opts = {};
});
afterEach(() => {
  neonConfig.opts = saved;
});

it("connects to the local database through the pool's own proxy settings and leaves the global config alone", async () => {
  const { db, end } = connect(process.env.DATABASE_URL!);
  try {
    const r = (await db.execute(sql`select 1 as one`)) as unknown as { rows: { one: number }[] };
    expect(r.rows[0].one).toBe(1);
    expect(neonConfig.opts).toEqual({});
  } finally {
    await end();
  }
});
