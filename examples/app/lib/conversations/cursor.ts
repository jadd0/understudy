import type { Cursor } from "./window";

/**
 * The opaque cursors of message windowing: base64url of a small JSON object, made and read only by the
 * server. Every field is checked here, before any of it reaches SQL, so a forged or damaged cursor is a `BadCursor`
 * (a clean refusal) and never a database error.
 *
 * An older cursor names the conversation it was taken in and the (sort_at, id) of the oldest message the reader
 * holds. A sync cursor carries only the database time of the read; it names no conversation, because a fan's first
 * page can be read before his conversation exists. Neither ever chooses which conversation is read: that comes
 * from the session (fan) or the bound page id, and is scope-checked on every call.
 */

export class BadCursor extends Error {
  constructor() {
    super("bad cursor");
    this.name = "BadCursor";
  }
}

export interface OlderKey {
  conversationId: string;
  /** `sort_at` as the database wrote it, to the microsecond (a JS Date would drop the last three digits). */
  sortAt: string;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The only time format the reads write: UTC, microseconds, as `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`. */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
/** The shape, and a real calendar time: a rolled-over date such as Feb 30 would be a database error, not a refusal. */
function isTime(t: unknown): t is string {
  if (typeof t !== "string" || !TIME.test(t)) return false;
  const d = new Date(t);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 23) === t.slice(0, 23);
}
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_LEN = 512;

export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

const encode = (o: object): Cursor => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");

function decode(cursor: unknown): Record<string, unknown> {
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > MAX_LEN || !BASE64URL.test(cursor)) throw new BadCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new BadCursor();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BadCursor();
  return parsed as Record<string, unknown>;
}

export function encodeOlder(key: OlderKey): Cursor {
  return encode({ k: "older", c: key.conversationId, t: key.sortAt, id: key.id });
}

/** Reads an older cursor, refusing one taken in a different conversation. */
export function decodeOlder(cursor: unknown, conversationId: string): OlderKey {
  const o = decode(cursor);
  if (o.k !== "older" || !isUuid(o.c) || !isUuid(o.id) || !isTime(o.t)) throw new BadCursor();
  if (o.c !== conversationId) throw new BadCursor();
  return { conversationId: o.c, sortAt: o.t, id: o.id };
}

export function encodeSync(dbNow: string): Cursor {
  return encode({ k: "sync", t: dbNow });
}

/** Reads a sync cursor: the database time of the read it came from. */
export function decodeSync(cursor: unknown): string {
  const o = decode(cursor);
  if (o.k !== "sync" || !isTime(o.t)) throw new BadCursor();
  return o.t;
}
