/**
 * Runs the hot-path queries against the volume seed (`seed-volume.ts`) and records how Postgres executes them.
 *
 * Each path calls the real code once with real parameters from the seeded data while the driver records the SQL it
 * sends; that exact statement is then run under `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` 20 times (after one
 * warm-up) inside a transaction that rolls back, so writes leave nothing behind. For every statement the output
 * keeps p50 and p95 execution time, the rows, the index and scan nodes used, and any Seq Scan on a table over 10k rows.
 *
 *   DATABASE_URL=<test database> npx tsx scripts/scale/explain.ts [--out docs/scaling/explain.json]
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { and, desc, eq, isNotNull } from "drizzle-orm";
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
  run: () => Promise<unknown>;
  /** Picks the statements of the run worth explaining. */
  pick: (c: Captured) => boolean;
  after?: () => Promise<unknown>;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

async function main() {
  const name = assertTestDatabase(process.env.DATABASE_URL);
  const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "docs/scaling/explain.json";

  const { db } = await import("@/db/client");
  const { dbConfigPort } = await import("@/lib/config");
  const { dbHost } = await import("@/lib/host/engine-host");
  const { acquireLease, releaseLease } = await import("../../packages/engine/src/lease");
  const { loadFacts } = await import("../../packages/engine/src/facts");
  const { loadInbound } = await import("../../packages/engine/src/turn");
  const { retrieveFts, retrieveVector } = await import("../../packages/engine/src/retrieve");
  const { sweep } = await import("../../packages/engine/src/sweep");
  const { personaCards, messages } = await import("../../packages/engine/src/schema");
  const { listInbox } = await import("@/lib/conversations/read");
  const { getHandoffs } = await import("@/lib/analytics/handoffs");
  const { makeQuery } = await import("@/lib/analytics/query");
  const { ne } = await import("drizzle-orm");

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const id = async (q: string) => String((await pool.query(q)).rows[0].id);
  const creatorId = await id(`select md5('seed:creator:100')::uuid as id`);
  const creatorUserId = await id(`select md5('seed:cuser:100')::uuid as id`);
  // Conversation 7 keeps its last fan message unanswered; 100 has offers and an open handoff.
  const convUnanswered = await id(`select md5('seed:conv:100:7')::uuid as id`);
  const convBusy = await id(`select md5('seed:conv:100:100')::uuid as id`);
  const convPlain = await id(`select md5('seed:conv:100:1')::uuid as id`);
  const fanBusy = await id(`select md5('seed:fan:100:100')::uuid as id`);
  const fanUnanswered = await id(`select md5('seed:fan:100:7')::uuid as id`);

  const ctx = {
    db,
    config: dbConfigPort,
    host: dbHost,
    // The sweep reads the clock once to start and again before each conversation: the second read is past the
    // start budget, so it scans for work and processes none.
    deps: { clock: { now: (() => { let n = 0; return () => (n++ === 0 ? 0 : 1e9); })(), sleep: async () => undefined } },
  } as unknown as Parameters<typeof acquireLease>[0];
  const vector = Array.from({ length: 1024 }, (_, i) => Math.sin(i));
  const retrieveDeps = { db, embedQuery: async () => vector };

  let lease: Awaited<ReturnType<typeof acquireLease>> = null;
  const paths: HotPath[] = [
    {
      name: "lease claim",
      source: "acquireLease (packages/engine/src/lease.ts)",
      run: async () => (lease = await acquireLease(ctx, convPlain, 60_000)),
      pick: (c) => /update conversations/.test(c.text),
      after: async () => lease && releaseLease(ctx, lease),
    },
    { name: "inbound load", source: "loadInbound (packages/engine/src/turn.ts)", run: () => loadInbound(ctx, convUnanswered), pick: (c) => /from messages m/.test(c.text) },
    {
      name: "facts",
      source: "loadFacts (packages/engine/src/facts.ts)",
      run: () => loadFacts(ctx, convBusy, fanBusy, creatorId, { declineWindowMinutes: 60, velocityWindowMinutes: 60 }),
      pick: (c) => /no_pitch_active/.test(c.text),
    },
    {
      name: "published card read",
      source: "the select in runTurn (packages/engine/src/turn.ts), built with the same drizzle calls",
      run: () =>
        db.select().from(personaCards).where(and(eq(personaCards.creatorId, creatorId), isNotNull(personaCards.publishedAt))).orderBy(desc(personaCards.version)).limit(1),
      pick: (c) => /persona_cards/.test(c.text),
    },
    {
      name: "chat history",
      source: "loadHistory (packages/engine/src/turn.ts), built with the same drizzle calls",
      run: () =>
        db
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.conversationId, convUnanswered), eq(messages.status, "sent"), ne(messages.sender, "system")))
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(600),
      pick: (c) => /from "messages"/.test(c.text),
    },
    { name: "retrieval, full text", source: "retrieveFts (packages/engine/src/retrieve.ts)", run: () => retrieveFts(creatorId, "coffee lighthouse sunrise", 6, retrieveDeps), pick: (c) => /persona_chunks/.test(c.text) },
    { name: "retrieval, vector", source: "retrieveVector (packages/engine/src/retrieve.ts)", run: () => retrieveVector(creatorId, "anything", 6, retrieveDeps), pick: (c) => /persona_chunks/.test(c.text) },
    {
      name: "sweep scan",
      source: "sweep (packages/engine/src/sweep.ts), run with a clock past its start budget so it scans and processes nothing",
      run: () => sweep(ctx),
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
            (select count(*) from turns)::int turns, (select count(*) from offers)::int offers, (select count(*) from persona_chunks)::int persona_chunks, (select count(*) from handoffs)::int handoffs`,
  )).rows[0];

  const results = [];
  for (const path of paths) {
    const statements = (await capture(path.run)).filter(path.pick);
    if (path.after) await path.after();
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
      seqScansOnBigTables: [...new Set(nodes.filter((n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] && bigTables.has(n["Relation Name"])).map((n) => n["Relation Name"]!))].sort(),
    });
    console.log(`${path.name}: p50 ${percentile(times, 50).toFixed(2)} ms, p95 ${percentile(times, 95).toFixed(2)} ms`);
  }

  writeFileSync(out, JSON.stringify({ database: name.replace(/^.*_test_/, "test_"), volume: counts, bigTableRowsOver: BIG_TABLE_ROWS, results }, null, 2) + "\n");
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
