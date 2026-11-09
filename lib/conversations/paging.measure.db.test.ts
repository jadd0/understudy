import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db, withTx } from "@/db/client";
import { getChanges, getOlderMessages, getWindowedSnapshot } from "./paging";
import { getSnapshot } from "./read";
import { asViewer, makeConversation, makeCreator, makeFan } from "./test-helpers";

/**
 * The windowing measurement, by hand only: `MEASURE=1 [MEASURE_OUT=<file>] TEST_DB_SCOPE=<x> npx vitest run
 * lib/conversations/paging.measure.db.test.ts`. Seeds one 5,000-message conversation and times the whole snapshot
 * against the windowed first load, an older page and a change read (median wall time of 7 runs, after one warm-up),
 * plus EXPLAIN ANALYZE execution time of the message query behind each.
 */
const N = 5000;
const RUNS = 7;

async function median(fn: () => Promise<unknown>): Promise<number> {
  await fn();
  const ms: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    await fn();
    ms.push(performance.now() - t0);
  }
  return Math.round(ms.sort((a, b) => a - b)[Math.floor(RUNS / 2)] * 10) / 10;
}

async function explain(query: ReturnType<typeof sql>): Promise<string> {
  const r = await db.execute(sql`explain (analyze, format json) ${query}`);
  const plan = (r.rows[0] as { "QUERY PLAN": [{ "Execution Time": number }] })["QUERY PLAN"][0];
  return `${plan["Execution Time"].toFixed(2)} ms`;
}

describe.skipIf(!process.env.MEASURE)("windowing measurement", () => {
  test("5,000-message conversation", { timeout: 300_000 }, async () => {
    const creator = await makeCreator();
    const fan = await makeFan();
    const conv = await makeConversation(creator.id, fan.id);
    await db.execute(sql`
      insert into messages (conversation_id, sender, body, created_at)
      select ${conv.id}, (case when g % 2 = 0 then 'fan' else 'ai' end)::sender,
             'message ' || g || ' ' || repeat('x', 80), now() - make_interval(secs => ${N} - g + 60)
      from generate_series(1, ${N}) g`);
    // An insert stamps updated_at with now(); history is old, as the migration's backfill leaves it.
    await withTx(async (tx) => {
      await tx.execute(sql`alter table messages disable trigger messages_set_updated_at`);
      await tx.execute(sql`update messages set updated_at = created_at where conversation_id = ${conv.id}`);
      await tx.execute(sql`alter table messages enable trigger messages_set_updated_at`);
    });
    await db.execute(sql`analyze messages`);
    const v = asViewer({ id: creator.userId, role: "creator" });
    const snap = await getWindowedSnapshot(v, conv.id);
    expect(snap.thread.messages).toHaveLength(15);

    const c = conv.id;
    const visible = sql`m.status = 'sent' and not m.suggested and (m.deliver_at is null or m.deliver_at <= now())`;
    const results = {
      wall: {
        fullSnapshot: await median(() => getSnapshot(v, c)),
        windowedFirstLoad: await median(() => getWindowedSnapshot(v, c)),
        olderPage: await median(() => getOlderMessages(v, c, snap.window.olderCursor)),
        changes: await median(() => getChanges(v, c, snap.window.syncCursor)),
      },
      explain: {
        fullMessages: await explain(sql`select m.* from messages m where m.conversation_id = ${c} and ${visible} order by coalesce(m.deliver_at, m.created_at), m.created_at, m.id`),
        firstPage: await explain(sql`select m.* from messages m where m.conversation_id = ${c} and ${visible} order by m.sort_at desc, m.id desc limit 16`),
        olderPage: await explain(
          sql`select m.* from messages m where m.conversation_id = ${c} and ${visible} and (m.sort_at, m.id) < (now() - interval '2000 seconds', 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid) order by m.sort_at desc, m.id desc limit 16`,
        ),
        changesIds: await explain(sql`
          select m.id from messages m where m.conversation_id = ${c} and m.updated_at > now() - interval '10 seconds'
          union select m.id from messages m where m.conversation_id = ${c} and m.sort_at > now() - interval '10 seconds' and m.sort_at <= now()
          union select m.id from offers o join messages m on m.offer_id = o.id where o.conversation_id = ${c} and m.offer_id is not null
            and (o.updated_at > now() - interval '10 seconds' or (o.expires_at > now() - interval '10 seconds' and o.expires_at <= now()))`),
      },
      payloadBytes: {
        fullSnapshot: JSON.stringify(await getSnapshot(v, c)).length,
        windowedFirstLoad: JSON.stringify(snap).length,
        changes: JSON.stringify(await getChanges(v, c, snap.window.syncCursor)).length,
      },
    };
    // Written to a file as well, since the test runner may hold back console output.
    console.log(JSON.stringify(results, null, 2));
    if (process.env.MEASURE_OUT) writeFileSync(process.env.MEASURE_OUT, JSON.stringify(results, null, 2));
  });
});
