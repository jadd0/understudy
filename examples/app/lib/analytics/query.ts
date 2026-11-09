import { sql, type SQL } from "drizzle-orm";
import type { Scope } from "./scope";
import type { Bucket, Range } from "./range";

/** Email pattern of the fans the eval runner creates. */
export const EVAL_FAN_EMAIL = "eval+%@understudy.test";

/** What every analytics query takes: the viewer's scope plus the window. `now` is injected, never read from a clock. */
export interface Query extends Scope {
  from: Date;
  to: Date;
  bucket: Bucket;
  now: Date;
}

export function makeQuery(scope: Scope, range: Pick<Range, "from" | "to" | "bucket">, now: Date = range.to): Query {
  return { ...scope, from: range.from, to: range.to, bucket: range.bucket, now };
}

const list = (ids: string[]) => sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);

/** Narrows to sim fans or away from them, as a predicate on a fan id column. */
export function simFan(q: Pick<Scope, "sim">, fanCol: SQL): SQL {
  if (q.sim === "exclude") return sql`not exists (select 1 from users sf where sf.id = ${fanCol} and sf.is_sim)`;
  if (q.sim === "only") return sql`exists (select 1 from users sf where sf.id = ${fanCol} and sf.is_sim)`;
  return sql`true`;
}

/**
 * The conversations a query may read, as a predicate on alias `c`. A creator's view leaves out every conversation
 * in or ever through the T&S queue, so no safety data reaches them.
 */
export function inScope(q: Scope, c = sql.raw("c")): SQL {
  if (q.creatorIds.length === 0) return sql`false`;
  const evalFree = q.includeEval
    ? sql`true`
    : sql`not exists (select 1 from users ef where ef.id = ${c}.fan_id and ef.email like ${EVAL_FAN_EMAIL})`;
  const base = sql`(${c}.creator_id in (${list(q.creatorIds)}) and ${evalFree} and ${simFan(q, sql`${c}.fan_id`)})`;
  if (q.includeTs) return base;
  return sql`(${base} and ${c}.mode not in ('handoff_ts', 'human_ts')
    and not exists (select 1 from handoffs th where th.conversation_id = ${c}.id and th.queue = 'ts'))`;
}

/** `col` in [from, to). */
export const inWindow = (col: SQL, q: Pick<Query, "from" | "to">): SQL =>
  sql`(${col} >= ${q.from.toISOString()}::timestamptz and ${col} < ${q.to.toISOString()}::timestamptz)`;

/** Start of the UTC bucket as epoch milliseconds. */
export const bucketMs = (col: SQL, bucket: Bucket): SQL =>
  sql`(extract(epoch from date_trunc(${sql.raw(`'${bucket === "hour" ? "hour" : "day"}'`)}, ${col} at time zone 'UTC')) * 1000)::float8`;

/** A config number: the creator's own row wins over the platform row. `creatorCol` is a uuid expression. */
export const cfgNum = (key: string, creatorCol: SQL): SQL =>
  sql`coalesce(
    (select (value #>> '{}')::float8 from config where key = ${key} and creator_id = ${creatorCol}),
    (select (value #>> '{}')::float8 from config where key = ${key} and creator_id is null))`;

/** Rate that is null, never NaN or Infinity, when nothing is in the denominator. */
export function rate(n: number, d: number): number | null {
  return d > 0 ? n / d : null;
}

/** bigint and numeric columns arrive as strings; whole cents must stay inside 2^53. */
export function int(v: unknown): number {
  const n = Number(v ?? 0);
  if (!Number.isSafeInteger(n)) throw new RangeError("value outside safe integer range");
  return n;
}

export const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export type Series<T> = { t: number } & T;

/** Fills empty buckets with zeros so a chart has an x for every bucket. */
export function dense<T extends Record<string, number>>(
  starts: number[],
  rows: Series<T>[],
  zero: T,
): Series<T>[] {
  const by = new Map(rows.map((r) => [r.t, r]));
  return starts.map((t) => by.get(t) ?? { t, ...zero });
}

import { db } from "@/db/client";

/** Runs a raw statement and returns its rows. */
export async function rowsOf<T = Record<string, unknown>>(stmt: SQL): Promise<T[]> {
  const { rows } = await db.execute(stmt);
  return rows as unknown as T[];
}
