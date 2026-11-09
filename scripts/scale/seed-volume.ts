/**
 * Fills a test database with creators, fans, conversations, messages, turns, offers, handoffs and persona chunks at
 * the shape the app produces, so the hot-path queries can be measured at volume (`explain.ts`). It writes only to a
 * database whose name contains `_test_`, and refuses anything else before it connects. Ids and text are derived from
 * the loop counters, so two runs on an empty database produce the same rows.
 *
 *   DATABASE_URL=$(TEST_DB_SCOPE=scale node scripts/test-db.mjs) npx tsx scripts/scale/seed-volume.ts \
 *     [--creators 200] [--fans-per-creator 100] [--messages-per-conversation 50]
 */
import { pathToFileURL } from "node:url";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { ENGINE_CONFIG, RETRIEVAL_CONFIG, WALLET_CONFIG } from "@/db/seed";

export interface VolumeOptions {
  creators: number;
  fansPerCreator: number;
  messagesPerConversation: number;
}

export const DEFAULTS: VolumeOptions = { creators: 200, fansPerCreator: 100, messagesPerConversation: 50 };

/** A minimal client: `pg`'s and Neon's both fit. */
export interface SqlClient {
  query(text: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

/** The database name of a connection URL, or a refusal when it is not a disposable test database. */
export function assertTestDatabase(url: string | undefined): string {
  if (!url) throw new Error("DATABASE_URL is not set");
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!/^[a-z0-9_]+$/.test(name) || !name.includes("_test_")) throw new Error("refusing to seed a database whose name has no _test_");
  return name;
}

const int = (n: number, what: string) => {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${what} must be a positive integer`);
  return n;
};

const VOCAB = "sunrise coffee lighthouse rooftop sunday playlist gym brunch sunset dog cat travel pizza movie beach hike rain tattoo guitar cooking".split(" ");

/** Seeds one batch of creators `[from, to)`. */
async function seedCreators(db: SqlClient, o: VolumeOptions, from: number, to: number) {
  const vocab = `array[${VOCAB.map((w) => `'${w}'`).join(",")}]`;
  const words = (seed: string, n: number) =>
    `(select string_agg((${vocab})[1 + (abs(hashtext(${seed} || ':' || g)) % ${VOCAB.length})], ' ') from generate_series(1, ${n}) g)`;
  const range = `generate_series(${from}, ${to - 1}) c`;
  const fans = `generate_series(1, ${o.fansPerCreator}) f`;

  await db.query(`insert into users (id, email, role, name) select md5('seed:cuser:' || c)::uuid, 'seed-creator-' || c || '@seed.invalid', 'creator', 'Creator ' || c from ${range}`);
  await db.query(`insert into creators (id, user_id, handle, display_name) select md5('seed:creator:' || c)::uuid, md5('seed:cuser:' || c)::uuid, 'seed-c' || c, 'Creator ' || c from ${range}`);
  await db.query(`insert into catalogue_items (id, creator_id, kind, title, teaser, price_cents, active)
    select md5('seed:item:' || c || ':' || i)::uuid, md5('seed:creator:' || c)::uuid, case when i % 4 = 0 then 'bundle' else 'ppv' end::catalogue_kind,
      'Item ' || i, ${words("'t' || c || i", 5)}, 500 + (i * 100), true
    from ${range}, generate_series(1, 12) i`);
  await db.query(`insert into persona_cards (id, creator_id, version, body, never_list, published_at)
    select md5('seed:card:' || c || ':' || v)::uuid, md5('seed:creator:' || c)::uuid, v, 'You are Creator ' || c || '. ' || ${words("'card' || c || v", 40)}, array['my ex'], now() - interval '30 days'
    from ${range}, generate_series(1, 2) v`);
  await db.query(`insert into persona_chunks (id, creator_id, source, text, meta, embedding)
    select md5('seed:chunk:' || c || ':' || i)::uuid, md5('seed:creator:' || c)::uuid, 'caption', ${words("'ch' || c || i", 14)}, jsonb_build_object('chunk_id', 'c' || c || '-' || i),
      ('[' || array_to_string(array(select round(random()::numeric, 3) from generate_series(1, 1024)), ',') || ']')::vector
    from ${range}, generate_series(1, 40) i`);
  await db.query(`insert into users (id, email, role, name, adult_confirmed_at)
    select md5('seed:fan:' || c || ':' || f)::uuid, 'seed-fan-' || c || '-' || f || '@seed.invalid', 'fan', 'Fan ' || c || '-' || f, now() from ${range}, ${fans}`);

  // One row per conversation; the message, turn, offer and handoff inserts all read it. Every 100th conversation is
  // waiting on a creator (an open handoff), every 50th keeps its last fan message unanswered, and every 10th had a
  // takeover: its last 1 to 5 replies were written by the creator (one in four by an admin) and then handed back.
  await db.query(`drop table if exists seed_conv`);
  await db.query(`create temp table seed_conv as
    select c, f, md5('seed:conv:' || c || ':' || f)::uuid as id, md5('seed:creator:' || c)::uuid as creator_id, md5('seed:fan:' || c || ':' || f)::uuid as fan_id,
      now() - ((1 + abs(hashtext('age' || c || ':' || f)) % 60) || ' days')::interval - interval '1 day' as created,
      (f % 100 = 0) as handoff, (f % 50 = 7) as unanswered,
      (f % 10 = 3) as takeover, 1 + abs(hashtext('staff' || c || ':' || f)) % 5 as staff_n
    from ${range}, ${fans}`);
  await db.query(`insert into conversations (id, creator_id, fan_id, mode, created_at)
    select id, creator_id, fan_id, case when handoff then 'handoff_creator' else 'ai' end::conversation_mode, created from seed_conv`);
  await db.query(`insert into fan_memory (creator_id, fan_id, profile, version) select creator_id, fan_id, '{"interests":["coffee"],"dislikes":[]}'::jsonb, 1 from seed_conv`);

  // A turn per fan message that was answered; fan messages are the odd positions, the answer is the next one.
  const m = o.messagesPerConversation;
  const lastFan = m % 2 === 1 ? m : m - 1;
  await db.query(`insert into turns (id, conversation_id, inbound_ids, jev_in, route, attempts, outcome, persona_version, models, tokens, cost_micros, ms_total, created_at)
    select md5('seed:turn:' || s.id || ':' || k)::uuid, s.id, array[md5('seed:msg:' || s.id || ':' || k)::uuid], '{"parsed":{"intent":"smalltalk"}}'::jsonb, 'reply', 1, 'replied', 2,
      '{"jev":"jev-1.14.0","generate":"claude-haiku-5-5"}'::jsonb, '{"generate":{"inputTokens":900,"outputTokens":40}}'::jsonb, 1200, 4000, s.created + (k * interval '3 minutes') + interval '20 seconds'
    from seed_conv s, generate_series(1, ${m}, 2) k
    where not (s.unanswered and k = ${lastFan})`);
  await db.query(`insert into messages (id, conversation_id, sender, body, turn_id, status, created_at)
    select md5('seed:msg:' || s.id || ':' || k)::uuid, s.id, case when k % 2 = 1 then 'fan' when s.takeover and k > ${m} - 2 * s.staff_n then (case when abs(hashtext('who' || s.id || k)) % 4 = 0 then 'admin' else 'creator' end) else 'ai' end::sender, ${words("s.id::text || k", 9)},
      case when k % 2 = 1 and not (s.unanswered and k = ${lastFan}) then md5('seed:turn:' || s.id || ':' || k)::uuid end, 'sent', s.created + (k * interval '3 minutes')
    from seed_conv s, generate_series(1, ${m}) k`);
  await db.query(`insert into offers (id, conversation_id, item_id, price_cents, expires_at, status, created_at, resolved_at)
    select md5('seed:offer:' || s.id || ':' || j)::uuid, s.id, md5('seed:item:' || s.c || ':' || (1 + j))::uuid, 700 + j * 100, s.created + interval '2 hours',
      (array['accepted','declined','expired'])[1 + (j % 3)]::offer_status, s.created + (j * interval '40 minutes'), s.created + (j * interval '40 minutes') + interval '5 minutes'
    from seed_conv s, generate_series(1, 2) j where s.f % 5 = 0`);
  await db.query(`insert into handoffs (id, conversation_id, queue, reason, status, opened_at)
    select md5('seed:handoff:' || id)::uuid, id, 'creator', 'custom_request', 'open', created + interval '1 hour' from seed_conv where handoff`);
}

/** The platform config rows the engine and the wallet read, so the code under measurement runs as it does in the app. */
export async function seedConfig(db: SqlClient) {
  const rows = JSON.stringify({ ...WALLET_CONFIG, ...RETRIEVAL_CONFIG, "retrieval.strategy": "fts", ...ENGINE_CONFIG }).replace(/'/g, "''");
  await db.query(`insert into config (key, value) select key, value from jsonb_each('${rows}'::jsonb) on conflict do nothing`);
}

export async function seedVolume(db: SqlClient, options: Partial<VolumeOptions> = {}) {
  const o = { ...DEFAULTS, ...options };
  int(o.creators, "creators");
  int(o.fansPerCreator, "fans per creator");
  if (!Number.isInteger(o.messagesPerConversation) || o.messagesPerConversation < 3) throw new Error("messages per conversation must be at least 3");
  await seedConfig(db);
  const first = await db.query(`select 1 from creators where id = md5('seed:creator:1')::uuid`);
  if (first.rows.length) throw new Error("this database already holds the volume seed");
  // About 50k messages per batch keeps each statement short.
  const perBatch = Math.max(1, Math.floor(50_000 / (o.fansPerCreator * o.messagesPerConversation)));
  for (let from = 1; from <= o.creators; from += perBatch) await seedCreators(db, o, from, Math.min(o.creators + 1, from + perBatch));
  await db.query(`analyze`);
}

function args(argv: string[]): Partial<VolumeOptions> {
  const out: Partial<VolumeOptions> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const v = Number(argv[i + 1]);
    if (argv[i] === "--creators") out.creators = v;
    else if (argv[i] === "--fans-per-creator") out.fansPerCreator = v;
    else if (argv[i] === "--messages-per-conversation") out.messagesPerConversation = v;
    else throw new Error(`unknown option ${argv[i]}`);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const name = assertTestDatabase(process.env.DATABASE_URL);
  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  const started = Date.now();
  try {
    await seedVolume(client, args(process.argv.slice(2)));
    const counts = await client.query(`select (select count(*) from creators) creators, (select count(*) from conversations) conversations, (select count(*) from messages) messages, (select count(*) from turns) turns`);
    console.log(`seeded ${name} in ${Math.round((Date.now() - started) / 1000)}s`, counts.rows[0]);
  } finally {
    client.release();
    await pool.end();
  }
}
