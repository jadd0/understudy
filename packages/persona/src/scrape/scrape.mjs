// Collects one Instagram account's posts, captions and the owner's own comments into the raw layout
// normalise.mjs reads:  <out>/<handle>/{posts.jsonl, profile.json, NOTES.md}
//
//   IG_SESSIONID=<your sessionid cookie> understudy-persona scrape --handle <you>
//
// Use it only on an account you own or have written permission to collect. The output holds other
// people's comments and stays out of git. Run with --help for the flags.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isMain, loadEnvFile, parseArgs, writeJson } from "../lib/io.mjs";
import { ENDPOINTS, InstagramError, createClient } from "./instagram.mjs";
import { pairReply } from "./pairing.mjs";
import { mapHerComment, mapPost, mapProfile, toThreadComment } from "./record.mjs";

// The committed synthetic creators. A scrape never writes over them.
const SYNTHETIC = ["junovale", "junofilm"];
const HANDLE = /^[A-Za-z0-9._]{1,30}$/;

export const DEFAULTS = {
  out: "data/persona/raw",
  delayMs: 1500,
  maxCommentPages: 15,
  maxThreads: 30,
  threadPages: 1,
};

export const USAGE = `Usage: IG_SESSIONID=<sessionid cookie> understudy-persona scrape --handle <account> [flags]

Collects an account's posts, captions and your own comment replies into
<out>/<handle>/{posts.jsonl, profile.json, NOTES.md}, the layout the persona normalise step reads.

CONSENT: use this only on an account you own or have written permission to collect. The output
contains other people's comments; keep it out of git (data/persona/raw/ is gitignored).

Flags
  --handle <name>            the account to collect (required)
  --out <dir>                output root (default ${DEFAULTS.out})
  --delay-ms <n>             pause between requests (default ${DEFAULTS.delayMs})
  --max-posts <n>            stop after n posts (default: the whole grid)
  --max-comment-pages <n>    comment pages read per post (default ${DEFAULTS.maxCommentPages})
  --max-threads <n>          reply threads expanded per post (default ${DEFAULTS.maxThreads})
  --thread-pages <n>         pages read per reply thread (default ${DEFAULTS.threadPages})
  --help                     print this text

Reads are GET-only, one at a time. A post that hits a cap is marked more_left_unscanned.`;

function cleanDir(out, handle) {
  if (!HANDLE.test(handle)) throw new Error("--handle must be an Instagram username");
  const dir = resolve(out, handle);
  if (SYNTHETIC.includes(handle.toLowerCase()) || SYNTHETIC.includes(resolve(out).split("/").pop().toLowerCase())) {
    throw new Error(`refusing to write into a synthetic creator's directory (${SYNTHETIC.join(", ")})`);
  }
  return dir;
}

/** Walks a cursor-paginated endpoint. Stops on no more pages, a repeated cursor, or `maxPages`. */
async function paginate({ fetchPage, maxPages, nextCursor }) {
  const seen = new Set();
  const pages = [];
  let cursor = null;
  let moreLeft = false;
  for (;;) {
    if (pages.length >= maxPages) {
      moreLeft = true;
      break;
    }
    const page = await fetchPage(cursor);
    pages.push(page);
    const next = nextCursor(page);
    if (!next) break;
    if (seen.has(next)) {
      // The server handed back a cursor it already gave: stop rather than loop.
      moreLeft = true;
      break;
    }
    seen.add(next);
    cursor = next;
  }
  return { pages, moreLeft };
}

async function scanPost({ client, item, handle, caps }) {
  const mediaId = item.pk ?? item.id;
  const scan = { pages: 0, top_level_comments_seen: 0, more_left_unscanned: false, reply_threads_expanded: 0 };
  const her = [];

  const { pages, moreLeft } = await paginate({
    fetchPage: (cursor) => client.get(ENDPOINTS.comments(mediaId, cursor)),
    maxPages: caps.maxCommentPages,
    nextCursor: (page) => (page.has_more_comments ? page.next_min_id : null),
  });
  scan.pages = pages.length;
  scan.more_left_unscanned = moreLeft;

  const mine = (user) => user.toLowerCase() === handle.toLowerCase();
  for (const page of pages) {
    for (const raw of page.comments ?? []) {
      scan.top_level_comments_seen++;
      const root = toThreadComment(raw);
      if (mine(root.user)) her.push({ ts: root.ts, record: mapHerComment(root, null) });
      if (!(raw.child_comment_count > 0)) continue;
      if (scan.reply_threads_expanded >= caps.maxThreads) {
        scan.more_left_unscanned = true;
        continue;
      }
      scan.reply_threads_expanded++;
      const children = await paginate({
        fetchPage: (cursor) => client.get(ENDPOINTS.children(mediaId, raw.pk, cursor)),
        maxPages: caps.threadPages,
        nextCursor: (child) => (child.has_more_tail_child_comments ? child.next_max_child_cursor : null),
      });
      if (children.moreLeft) scan.more_left_unscanned = true;
      const kids = children.pages.flatMap((child) => child.child_comments ?? []).map(toThreadComment);
      const thread = [root, ...kids.sort((a, b) => a.ts - b.ts)];
      for (const reply of kids) {
        if (mine(reply.user)) her.push({ ts: reply.ts, record: mapHerComment(reply, pairReply({ reply, thread })) });
      }
    }
  }
  her.sort((a, b) => a.ts - b.ts);
  return { herComments: her.map((entry) => entry.record), scan };
}

function renderNotes({ handle, capturedAt, caps, counts, stoppedBy }) {
  const lines = [
    `# ${handle}: scrape notes`,
    "",
    `Collected ${capturedAt} by scripts/persona/scrape/scrape.mjs. The endpoints it reads are unverified until a live run.`,
    "",
    ...(stoppedBy ? [`**Incomplete.** The run stopped early: ${stoppedBy}`, ""] : []),
    "| | |",
    "|---|---|",
    `| Posts | ${counts.posts} |`,
    `| Posts that hit a scan cap (more_left_unscanned) | ${counts.capped} |`,
    `| The owner's replies | ${counts.replies} (exact ${counts.exact}, thread root ${counts.threadRoot}) |`,
    `| The owner's top-level comments | ${counts.topLevel} |`,
    `| Her GIF or sticker comments | ${counts.nonText} |`,
    `| Caps | ${caps.maxCommentPages} comment pages per post, ${caps.maxThreads} threads per post, ${caps.threadPages} page per thread |`,
    "",
    "Image descriptions are left empty: the scraper does not describe images.",
    "",
  ];
  return lines.join("\n");
}

/**
 * Runs one scrape. `client` is the GET-only transport. posts.jsonl is appended one post at a time,
 * so a run that stops on a 401 or 429 keeps what it had written.
 */
export async function scrape({ client, handle, out = DEFAULTS.out, caps = {}, maxPosts = Infinity, now = () => new Date() }) {
  const limits = { ...DEFAULTS, ...caps };
  const dir = cleanDir(out, handle);
  const capturedAt = now().toISOString().slice(0, 10);
  const counts = { posts: 0, capped: 0, replies: 0, exact: 0, threadRoot: 0, topLevel: 0, nonText: 0 };
  let stoppedBy = null;
  let error = null;

  mkdirSync(dir, { recursive: true });
  const postsPath = join(dir, "posts.jsonl");
  writeFileSync(postsPath, "");
  try {
    const profileResponse = await client.get(ENDPOINTS.profile(handle));
    const profile = mapProfile(profileResponse, { capturedAt });
    const userId = profileResponse.data.user.id;
    writeJson(join(dir, "profile.json"), profile);

    const feed = await paginate({
      fetchPage: (cursor) => client.get(ENDPOINTS.feed(userId, cursor)),
      maxPages: Infinity,
      nextCursor: (page) => (page.more_available ? page.next_max_id : null),
    });
    outer: for (const page of feed.pages) {
      for (const gridItem of page.items ?? []) {
        if (counts.posts >= maxPosts) break outer;
        const info = await client.get(ENDPOINTS.info(gridItem.pk ?? gridItem.id));
        const item = info.items?.[0] ?? gridItem;
        const record = mapPost(item, { handle, index: counts.posts, userId });
        const { herComments, scan } = await scanPost({ client, item, handle, caps: limits });
        appendFileSync(postsPath, JSON.stringify({ ...record, her_comments: herComments, comment_scan: scan }) + "\n");
        counts.posts++;
        if (scan.more_left_unscanned) counts.capped++;
        for (const comment of herComments) {
          if (comment.kind === "top_level") counts.topLevel++;
          else {
            counts.replies++;
            if (comment.replying_to_basis === "replied_to_comment_id") counts.exact++;
            else counts.threadRoot++;
          }
          if (comment.non_text) counts.nonText++;
        }
      }
    }
  } catch (caught) {
    error = caught;
    stoppedBy = caught instanceof InstagramError ? caught.message : `${caught?.name ?? "Error"}`;
  }
  writeFileSync(join(dir, "NOTES.md"), renderNotes({ handle, capturedAt, caps: limits, counts, stoppedBy }));
  if (error) throw error;
  return { dir, counts };
}

const intFlag = (value, name, fallback) => {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
};

/** CLI entry. Returns the exit code; takes its environment and fetch so a test can drive it. */
export async function main({ argv, env, fetch: fetchImpl = globalThis.fetch, sleep, stdout = console.log, stderr = console.error, now }) {
  const args = parseArgs(argv);
  if (args.help) {
    stdout(USAGE);
    return 0;
  }
  try {
    if (typeof args.handle !== "string") throw new Error("--handle <account> is required (see --help)");
    const sessionId = env.IG_SESSIONID;
    if (!sessionId) throw new Error("IG_SESSIONID is not set: export your instagram.com sessionid cookie as IG_SESSIONID");
    const out = typeof args.out === "string" ? args.out : DEFAULTS.out;
    cleanDir(out, args.handle);
    const client = createClient({ fetch: fetchImpl, sessionId, delayMs: intFlag(args["delay-ms"], "--delay-ms", DEFAULTS.delayMs), sleep });
    const result = await scrape({
      client,
      handle: args.handle,
      out,
      maxPosts: intFlag(args["max-posts"], "--max-posts", Infinity),
      caps: {
        maxCommentPages: intFlag(args["max-comment-pages"], "--max-comment-pages", DEFAULTS.maxCommentPages),
        maxThreads: intFlag(args["max-threads"], "--max-threads", DEFAULTS.maxThreads),
        threadPages: intFlag(args["thread-pages"], "--thread-pages", DEFAULTS.threadPages),
      },
      now,
    });
    stdout(JSON.stringify({ dir: result.dir, ...result.counts }));
    return 0;
  } catch (error) {
    // Only the message of our own errors is printed: it never holds a response body or the cookie.
    stderr(error instanceof InstagramError || error instanceof Error ? `scrape stopped: ${error.message}` : "scrape stopped");
    return 1;
  }
}

if (isMain(import.meta.url)) {
  loadEnvFile(".env.local");
  process.exitCode = await main({ argv: process.argv.slice(2), env: process.env });
}
