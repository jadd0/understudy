/**
 * Runs the hot-path queries against the volume seed (`seed-volume.ts`) and records how Postgres executes them.
 *
 * Each path calls the real code once with real parameters from the seeded data while the driver records the SQL it
 * sends (two functions the engine does not export have their statement read out of the source instead); that exact statement is then run under `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` 20 times (after one
 * warm-up) inside a transaction that rolls back, so writes leave nothing behind. For every statement the output
 * keeps p50 and p95 execution time, the rows, the index and scan nodes used, and any Seq Scan on a table over 10k rows.
 *
 *   DATABASE_URL=<test database> npx tsx scripts/scale/explain.ts [--out docs/scaling/explain.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import { createChatter, retrieveFts, retrieveVector } from "@understudy/engine";
import { messages, personaCards } from "@understudy/engine/schema";
import { Client, Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { assertTestDatabase } from "./seed-volume";

neonConfig.webSocketConstructor = ws;

const RUNS = 20;
const BIG_TABLE_ROWS = 10_000;

interface Captured {
  text: string;
  values: unknown[];
}
interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Rows"?: number;
  "Plan Rows"?: number;
  "Actual Loops"?: number;
  "Actual Total Time"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: PlanNode[];
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) throw new Error("no samples");
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** Every node of a plan tree, parents first. */
export function nodesOf(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodesOf)];
}

/** Statements the driver sends while `run` executes, without the transaction control ones. */
async function capture(run: () => Promise<unknown>): Promise<Captured[]> {
  const seen: Captured[] = [];
  const original = Client.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Client.prototype as any).query = function (this: unknown, arg: unknown, ...rest: unknown[]) {
    // Drizzle sends `query({ text, ... }, values)`; a plain call sends `query(text, values)` or `query({ text, values })`.
    const q = typeof arg === "string" ? { text: arg, values: undefined } : (arg as { text?: string; values?: unknown[] });
    const values = q?.values ?? (Array.isArray(rest[0]) ? (rest[0] as unknown[]) : []);
    if (q?.text && !/^\s*(begin|commit|rollback|set |select pg_)/i.test(q.text)) seen.push({ text: q.text, values });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (original as any).call(this, arg, ...rest);
  };
  try {
    await run();
  } finally {
    Client.prototype.query = original;
  }
  return seen;
}

interface HotPath {
  name: string;
  /** What the statement is: where its SQL comes from. */
  source: string;
  /** Calls the real code while the driver records what it sends. */
  run?: () => Promise<unknown>;
  /** Picks the statements of the run worth explaining. */
  pick?: (c: Captured) => boolean;
  /** For a function the engine does not export: its statement read out of the source file. */
  fixed?: Captured;
}

/**
 * The first `sql` template after `function <name>` in `file`, with each interpolation replaced by a numbered
 * parameter in order. It is the text the function sends, read from the source so it cannot drift from it.
 */
function statementOf(file: string, name: string): string {
  const src = readFileSync(file, "utf8");
  const at = src.indexOf(`function ${name}`);
  const open = src.indexOf("execute(sql`", at);
  if (at < 0 || open < 0) throw new Error(`${name}: no sql template found in ${file}`);
  const start = open + "execute(sql`".length;
  let n = 0;
  return src.slice(start, src.indexOf("`)", start)).replace(/\$\{[^}]*\}/g, () => "$" + ++n);
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

async function main() {
  assertTestDatabase(process.env.DATABASE_URL);
  const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "docs/scaling/explain.json";

  const { db } = await import("@/db/client");
  const { dbConfigPort } = await import("@/lib/config");
  const { dbHost } = await import("@/lib/host/engine-host");
  const { listInbox } = await import("@/lib/conversations/read");
  const { getHandoffs } = await import("@/lib/analytics/handoffs");
  const { makeQuery } = await import("@/lib/analytics/query");

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const id = async (q: string) => String((await pool.query(q)).rows[0].id);
  const creatorId = await id(`select md5('seed:creator:100')::uuid as id`);
  const creatorUserId = await id(`select md5('seed:cuser:100')::uuid as id`);
  // Conversation 7 keeps its last fan message unanswered; 100 has offers and an open handoff.
  const convUnanswered = await id(`select md5('seed:conv:100:7')::uuid as id`);
  const convBusy = await id(`select md5('seed:conv:100:100')::uuid as id`);
  const convPlain = await id(`select md5('seed:conv:100:1')::uuid as id`);
  const fanBusy = await id(`select md5('seed:fan:100:100')::uuid as id`);

  // The sweep reads the clock once to start and again before each conversation: the second read is past the start
  // budget, so it scans for work and processes none.
  let reads = 0;
  const chatter = createChatter({
    db,
    config: dbConfigPort,
    host: dbHost,
    deps: { clock: { now: () => (reads++ === 0 ? 0 : 1e9), sleep: async () => undefined } },
  } as unknown as Parameters<typeof createChatter>[0]);
  const vector = Array.from({ length: 1024 }, (_, i) => Math.sin(i));
  const retrieveDeps = { db, embedQuery: async () => vector };

  const paths: HotPath[] = [
    {
      name: "lease claim",
      source: "acquireLease (packages/engine/src/conversation/lease.ts), statement read from the source",
      fixed: { text: statementOf("packages/engine/src/conversation/lease.ts", "acquireLease"), values: [crypto.randomUUID(), 60, convPlain] },
    },
    {
      name: "inbound load",
      source: "loadInbound (packages/engine/src/turn/inbound.ts), statement read from the source",
      fixed: { text: statementOf("packages/engine/src/turn/inbound.ts", "loadInbound"), values: [convUnanswered, convUnanswered] },
    },
    {
      name: "facts",
      source: "loadFacts (packages/engine/src/turn/facts.ts)",
      run: () => chatter.loadFacts(convBusy, fanBusy, creatorId, { declineWindowMinutes: 60, velocityWindowMinutes: 60, strikeWindowDays: 90 }),
      pick: (c) => /no_pitch_active/.test(c.text),
    },
    {
      name: "published card read",
      source: "the select in runTurn (packages/engine/src/turn/run.ts), built with the same drizzle calls",
      run: () =>
        db.select().from(personaCards).where(and(eq(personaCards.creatorId, creatorId), isNotNull(personaCards.publishedAt))).orderBy(desc(personaCards.version)).limit(1),
      pick: (c) => /persona_cards/.test(c.text),
    },
    {
      name: "chat history",
      source: "loadHistory (packages/engine/src/turn/inbound.ts), built with the same drizzle calls",
      run: () =>
        db
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.conversationId, convUnanswered), eq(messages.status, "sent"), ne(messages.sender, "system")))
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(600),
      pick: (c) => /from "messages"/.test(c.text),
    },
    { name: "retrieval, full text", source: "retrieveFts (packages/engine/src/retrieval/retrieve.ts)", run: () => retrieveFts(creatorId, "coffee lighthouse sunrise", 6, retrieveDeps), pick: (c) => /persona_chunks/.test(c.text) },
    { name: "retrieval, vector", source: "retrieveVector (packages/engine/src/retrieval/retrieve.ts)", run: () => retrieveVector(creatorId, "anything", 6, retrieveDeps), pick: (c) => /persona_chunks/.test(c.text) },
    {
      name: "sweep scan",
      source: "sweep (packages/engine/src/conversation/sweep.ts), run with a clock past its start budget so it scans and processes nothing",
      run: () => chatter.sweep(),
      pick: (c) => /group by c\.id/.test(c.text),
    },
    { name: "creator inbox page", source: "listInbox (lib/conversations/read.ts)", run: () => listInbox({ id: creatorUserId, role: "creator" }), pick: (c) => /from "conversations"/.test(c.text) },
    {
      name: "handoff queue (open handoffs for one creator)",
      source: "getHandoffs (lib/analytics/handoffs.ts)",
      run: () => {
        const to = new Date();
        return getHandoffs(makeQuery({ creatorIds: [creatorId], includeTs: false }, { from: new Date(to.getTime() - 90 * 86_400_000), to, bucket: "day" }, to));
      },
      pick: (c) => /h\.status = 'open'/.test(c.text),
    },
  ];

  const bigTables = new Set<string>();
  for (const r of (await pool.query(`select relname from pg_class where relkind = 'r' and reltuples > ${BIG_TABLE_ROWS}`)).rows) bigTables.add(String(r.relname));
  const counts = (await pool.query(
    `select (select count(*) from creators)::int creators, (select count(*) from conversations)::int conversations, (select count(*) from messages)::int messages,
            (select count(*) from turns)::int turns, (select count(*) from offers)::int offers, (select count(*) from persona_chunks)::int persona_chunks, (select count(*) from handoffs)::int handoffs,
            (select count(*) from messages where sender in ('creator', 'admin'))::int staff_messages, (select count(distinct conversation_id) from messages where sender in ('creator', 'admin'))::int staff_conversations`,
  )).rows[0];

  const server = (
    await pool.query(
      `select current_setting('server_version') as version, current_setting('shared_buffers') as shared_buffers,
              current_setting('effective_cache_size') as effective_cache_size, current_setting('max_connections') as max_connections,
              current_setting('work_mem') as work_mem`,
    )
  ).rows[0];
  const results = [];
  for (const path of paths) {
    const statements = path.fixed ? [path.fixed] : (await capture(path.run!)).filter(path.pick!);
    if (statements.length === 0) throw new Error(`${path.name}: no statement matched`);
    // The longest matching statement is the one that does the work.
    const statement = statements.sort((a, b) => b.text.length - a.text.length)[0];
    const times: number[] = [];
    let plan: { Plan: PlanNode; "Execution Time": number } | undefined;
    for (let i = 0; i <= RUNS; i++) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const res = await client.query({ text: `explain (analyze, buffers, format json) ${statement.text}`, values: statement.values });
        plan = (res.rows[0]["QUERY PLAN"] as unknown[])[0] as typeof plan;
        if (i > 0) times.push(plan!["Execution Time"]);
      } finally {
        await client.query("rollback").catch(() => undefined);
        client.release();
      }
    }
    times.sort((a, b) => a - b);
    const nodes = nodesOf(plan!.Plan);
    results.push({
      name: path.name,
      source: path.source,
      statement: squash(statement.text),
      runs: RUNS,
      p50Ms: percentile(times, 50),
      p95Ms: percentile(times, 95),
      rows: plan!.Plan["Actual Rows"] ?? 0,
      scans: [...new Set(nodes.filter((n) => /Scan/.test(n["Node Type"])).map((n) => `${n["Node Type"]}${n["Relation Name"] ? ` on ${n["Relation Name"]}` : ""}${n["Index Name"] ? ` using ${n["Index Name"]}` : ""}`))].sort(),
      sharedHitBlocks: plan!.Plan["Shared Hit Blocks"] ?? 0,
      sharedReadBlocks: plan!.Plan["Shared Read Blocks"] ?? 0,
      // Every node with what the planner expected and what happened; "loops" multiplies the per-loop rows and time.
      nodes: nodes.map((n) => ({
        type: n["Node Type"],
        relation: n["Relation Name"] ?? null,
        index: n["Index Name"] ?? null,
        planRows: n["Plan Rows"] ?? null,
        actualRows: n["Actual Rows"] ?? null,
        loops: n["Actual Loops"] ?? null,
        actualTotalMs: n["Actual Total Time"] ?? null,
        sharedHitBlocks: n["Shared Hit Blocks"] ?? null,
      })),
      seqScansOnBigTables: [...new Set(nodes.filter((n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] && bigTables.has(n["Relation Name"])).map((n) => n["Relation Name"]!))].sort(),
    });
    console.log(`${path.name}: p50 ${percentile(times, 50).toFixed(2)} ms, p95 ${percentile(times, 95).toFixed(2)} ms`);
  }

  // Size on disk of every table over 1,000 rows and of the indexes on the big ones, as the database reports it.
  const tables = (
    await pool.query(
      `select c.relname as table, c.reltuples::bigint as rows, pg_table_size(c.oid) as heap_bytes, pg_indexes_size(c.oid) as index_bytes,
              pg_total_relation_size(c.oid) as total_bytes, round(pg_total_relation_size(c.oid)::numeric / nullif(c.reltuples::numeric, 0), 1) as total_bytes_per_row
       from pg_class c where c.relkind = 'r' and c.relnamespace = 'public'::regnamespace and c.reltuples > 1000 order by pg_total_relation_size(c.oid) desc`,
    )
  ).rows.map((r) => ({ table: r.table, rows: Number(r.rows), heapBytes: Number(r.heap_bytes), indexBytes: Number(r.index_bytes), totalBytes: Number(r.total_bytes), totalBytesPerRow: Number(r.total_bytes_per_row) }));
  const indexes = (
    await pool.query(
      `select s.relname as table, s.indexrelname as index, pg_relation_size(s.indexrelid) as bytes from pg_stat_user_indexes s
       where s.relname in ('messages', 'turns', 'persona_chunks') order by s.relname, pg_relation_size(s.indexrelid) desc`,
    )
  ).rows.map((r) => ({ table: r.table, index: r.index, bytes: Number(r.bytes) }));

  writeFileSync(out, JSON.stringify({ server, volume: counts, bigTableRowsOver: BIG_TABLE_ROWS, tables, indexes, results }, null, 2) + "\n");
  console.log(`wrote ${out}`);
  await pool.end();
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("explain failed:", e?.code ?? e?.name ?? "error", String(e?.message ?? "").slice(0, 200));
    process.exit(1);
  });
}
