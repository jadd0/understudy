# Volume measurement

Fills a disposable test database with about a million messages, then records how the hot-path queries run. The
results are in `docs/scaling/explain.json` and written up in `docs/SCALING.md`.

Both scripts refuse a database whose name does not contain `_test_`.

```bash
# 1. a database of its own on the project (name ends in the scope; the scope is capped at 8 characters)
export TEST_DB_SCOPE=scale
export DATABASE_URL=$(node scripts/test-db.mjs)

# 2. about a minute at the defaults: 200 creators x 100 fans x 50 messages
npx tsx scripts/scale/seed-volume.ts [--creators 200] [--fans-per-creator 100] [--messages-per-conversation 50]

# 3. EXPLAIN (ANALYZE, BUFFERS) each hot path, 20 runs after a warm-up
npx tsx scripts/scale/explain.ts --out docs/scaling/explain.json
```

`explain.ts` calls the real code (`loadFacts`, `retrieveFts`, `retrieveVector`, `sweep`, `listInbox`, `getHandoffs`)
while recording the SQL the driver sends, then explains that exact statement inside a transaction that rolls back.
The lease claim and the inbound load are not exported by the engine, so their statements are read out of
`lease.ts` and `turn.ts`; the card read and the history read are built with the same drizzle calls as `turn.ts`. A path whose plan has a Seq Scan on a table over 10,000 rows lists it
under `seqScansOnBigTables`.

The seed is deterministic: ids come from the loop counters, so two runs on an empty database give the same rows.
Drop the database when you are done; it is several hundred megabytes.

The JSON also records the server version and settings (`server`), the row counts (`volume`), the size of each table and
of the indexes on the big ones (`tables`, `indexes`), and for every path the buffer hits and each plan node's planned
rows, actual rows, loops and time (`results[].sharedHitBlocks`, `results[].nodes`). The database name is left out.
