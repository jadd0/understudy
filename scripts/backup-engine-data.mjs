// Saves the data a database rebuild would lose, and puts it back afterwards.
//   node scripts/backup-engine-data.mjs <file>             dump persona cards, persona chunks and config from DATABASE_URL
//   node scripts/backup-engine-data.mjs <file> --restore   write the cards and chunks back, report config differences
// Rows are keyed by the creator's user email, not the creator id: a reseed makes new ids. A restore is one
// transaction, so it either writes every row or none. Config comes from the seed; a differing row is reported, never written.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

const CREATOR_EMAIL = `(select u.email from creators c join users u on u.id = c.user_id where c.id = t.creator_id)`;

/** Writes the three tables to `file` as JSON. Returns the row counts. */
export async function dump(url, file) {
  const pool = new Pool({ connectionString: String(url) });
  try {
    const cards = (await pool.query(
      `select t.id, ${CREATOR_EMAIL} as creator_email, t.version, t.body, t.never_list, t.published_at from persona_cards t order by t.creator_id, t.version`,
    )).rows;
    const chunks = (await pool.query(
      `select t.id, ${CREATOR_EMAIL} as creator_email, t.source::text as source, t.source_url, t.text, t.meta, t.embedding::text as embedding from persona_chunks t order by t.id`,
    )).rows;
    const config = (await pool.query(
      `select t.key, ${CREATOR_EMAIL} as creator_email, t.value from config t order by t.key`,
    )).rows;
    if ([...cards, ...chunks].some((r) => r.creator_email == null)) throw new Error("a persona row has a creator with no user email");
    writeFileSync(file, JSON.stringify({ cards, chunks, config }));
    return { cards: cards.length, chunks: chunks.length, config: config.length };
  } finally {
    await pool.end();
  }
}

/**
 * Writes the dumped cards and chunks into `url` in one transaction, pointing each at the creator whose user has the
 * dumped email. Returns the counts and the config rows whose value differs from the dump.
 */
export async function restore(url, file) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  const pool = new Pool({ connectionString: String(url) });
  const client = await pool.connect();
  try {
    await client.query("begin");
    const creatorId = new Map();
    for (const email of new Set([...data.cards, ...data.chunks].map((r) => r.creator_email))) {
      const { rows } = await client.query(
        "select c.id from creators c join users u on u.id = c.user_id where u.email = $1",
        [email],
      );
      if (rows.length !== 1) throw new Error("no creator for a dumped user email");
      creatorId.set(email, rows[0].id);
    }
    for (const r of data.cards) {
      await client.query(
        "insert into persona_cards (id, creator_id, version, body, never_list, published_at) values ($1, $2, $3, $4, $5, $6)",
        [r.id, creatorId.get(r.creator_email), r.version, r.body, r.never_list, r.published_at],
      );
    }
    for (const r of data.chunks) {
      await client.query(
        "insert into persona_chunks (id, creator_id, source, source_url, text, meta, embedding) values ($1, $2, $3::chunk_source, $4, $5, $6::jsonb, $7::vector)",
        [r.id, creatorId.get(r.creator_email), r.source, r.source_url, r.text, r.meta == null ? null : JSON.stringify(r.meta), r.embedding],
      );
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }

  const differing = [];
  try {
    for (const r of data.config) {
      const { rows } = await pool.query(
        `select t.value from config t where t.key = $1 and ((t.creator_id is null and $2::text is null) or ${CREATOR_EMAIL} = $2)`,
        [r.key, r.creator_email],
      );
      const now = rows.length ? JSON.stringify(rows[0].value) : undefined;
      if (now !== JSON.stringify(r.value)) differing.push({ key: r.key, creator_email: r.creator_email, dumped: r.value, current: rows.length ? rows[0].value : null });
    }
  } finally {
    await pool.end();
  }
  return { cards: data.cards.length, chunks: data.chunks.length, differing };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, flag] = process.argv.slice(2);
  const url = process.env.DATABASE_URL;
  if (!file || !url || (flag && flag !== "--restore")) {
    console.error("usage: DATABASE_URL=... node scripts/backup-engine-data.mjs <file> [--restore]");
    process.exit(1);
  }
  (flag ? restore(url, file) : dump(url, file)).then(
    (r) => {
      if (flag) {
        console.log(`restored ${r.cards} cards, ${r.chunks} chunks`);
        for (const d of r.differing) console.log(`config differs: ${d.key} ${d.creator_email ?? "(platform)"}: dump=${JSON.stringify(d.dumped)} current=${JSON.stringify(d.current)}`);
        if (r.differing.length === 0) console.log("config: no differences");
      } else {
        console.log(`dumped ${r.cards} cards, ${r.chunks} chunks, ${r.config} config rows`);
      }
    },
    (e) => {
      console.error("backup failed:", e?.code ?? e?.name ?? "error");
      process.exit(1);
    },
  );
}
