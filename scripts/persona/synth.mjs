// Synthetic creator -> raw scrape layout: <out>/<handle>/{posts.jsonl, profile.json, NOTES.md}.
//
//   node scripts/persona/synth.mjs --model <id> [--brief scripts/persona/synth-brief.md]
//        [--out data/persona/raw] [--seed juno-2026] [--budget 1500000] [--concurrency 4]
//
// The output has the exact shape the Instagram scraper writes, so normalise and every stage after it
// run unchanged on a creator who does not exist. Code owns the structure: dates, post types, which posts
// are collabs, which captions are empty, how many replies each post gets, the fan handles, GIF replies,
// and whether a reply's pairing is exact or thread-first. Claude only writes the words, from the brief.
// That split keeps every edge case normalise branches on present in known proportions.
//
// Batches cache under <out>/.synth-cache/ so a failed run resumes without paying for finished batches.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClaude } from "./lib/claude.mjs";
import { isMain, loadEnvFile, parseArgs, seededRng, TokenBudget, writeJson, writeJsonl } from "./lib/io.mjs";

export const MAIN = "junovale";
export const SIDE = "junofilm";

// Posts per year on the main account; the side account starts in 2025.
const MAIN_YEARS = { 2022: 30, 2023: 45, 2024: 55, 2025: 55, 2026: 45 };
const SIDE_YEARS = { 2025: 8, 2026: 6 };
// The last capture date: nothing is dated after it.
const CAPTURED = "2026-11-05";

// Invented accounts that co-own collab posts and write those captions. The shop only before she left it.
const COLLAB_OWNERS = [
  { handle: "saltwaterskates", from: "2024-06-01" },
  { handle: "bluelipsswim", from: "2024-06-01" },
  { handle: "rethread.app", from: "2025-01-01" },
  { handle: "northlaine.vintage", from: "2022-01-01", until: "2024-06-30" },
];

const FIRST = ["maddie", "tom", "lottie", "jess", "ollie", "priya", "sam", "kit", "hannah", "dan", "freya", "luca",
  "meg", "theo", "ash", "rosie", "jamie", "nina", "callum", "ella", "zak", "imogen", "ravi", "beth", "finn", "cass",
  "mo", "georgia", "alfie", "tara", "jules", "noor", "harvey", "evie", "kian", "molly", "seb", "aisha", "rory", "daisy"];
const WORDS = ["skates", "swims", "film", "draws", "inthesea", "brighton", "hove", "thrifts", "outdoors", "makes",
  "sunday", "rolls", "pages", "salt", "wavey", "moth", "seaside", "studio", "travels", "vinyl"];

/** A deterministic, invented handle: first name plus one of a few common shapes. */
function fanHandle(rng) {
  const f = FIRST[Math.floor(rng() * FIRST.length)];
  const w = WORDS[Math.floor(rng() * WORDS.length)];
  const n = Math.floor(rng() * 99) + 1;
  const shapes = [`${f}.${w}`, `${f}${w}`, `${f}_${w}`, `${f}.${n}`, `x.${f}.x`, `${f}${w}${n}`, `its${f}`];
  return shapes[Math.floor(rng() * shapes.length)];
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function shortcode(rng) {
  let s = "";
  for (let i = 0; i < 11; i++) s += B64[Math.floor(rng() * 64)];
  return s;
}

function dateIn(year, rng) {
  const start = Date.UTC(year, 0, 1);
  const end = Math.min(Date.UTC(year + 1, 0, 1), Date.parse(`${CAPTURED}T00:00:00Z`));
  return new Date(start + Math.floor(rng() * (end - start))).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function pick(rng, weights) {
  let r = rng() * weights.reduce((a, [, w]) => a + w, 0);
  for (const [value, w] of weights) if ((r -= w) < 0) return value;
  return weights[weights.length - 1][0];
}

/**
 * The structure of every post, decided by code from the seed. Each slot says what Claude must write:
 * whether the caption is empty, who owns a collab, how many fan comments she replied to, and how many
 * top-level comments of her own it carries.
 */
export function skeleton(seed) {
  const rng = seededRng(`${seed}:skeleton`);
  const build = (account, years) => {
    const slots = [];
    for (const [year, count] of Object.entries(years)) {
      for (let i = 0; i < count; i++) {
        const date = dateIn(Number(year), rng);
        const type = pick(rng, [["carousel", 55], ["reel", 38], ["photo", 7]]);
        const owners = COLLAB_OWNERS.filter((o) => date >= o.from && (!o.until || date <= o.until));
        const collab = account === MAIN && owners.length > 0 && rng() < 0.05 ? owners[Math.floor(rng() * owners.length)].handle : null;
        const emptyCaption = !collab && rng() < 0.06;
        // Recent posts draw more replies: she answers fans more once the page is her job.
        const replyRate = date < "2024" ? 0.35 : 0.55;
        const pairs = rng() < replyRate ? 2 + Math.floor(rng() * (date < "2024" ? 6 : 12)) : 0;
        const topLevel = rng() < 0.06 ? 1 : 0;
        slots.push({ account, date, type, collab_owner: collab, empty_caption: emptyCaption, pairs, top_level: topLevel });
      }
    }
    slots.sort((a, b) => (a.date < b.date ? 1 : -1));
    // The grid's pinned post: a recent one with replies, moved to the front as Instagram shows it.
    const pin = slots.findIndex((s) => s.date >= "2026" && s.pairs > 0 && !s.collab_owner);
    if (pin > 0) slots.unshift(...slots.splice(pin, 1));
    if (pin >= 0) slots[0].pinned = true;
    return slots.map((s, index) => ({ ...s, index, shortcode: shortcode(rng) }));
  };
  return { [MAIN]: build(MAIN, MAIN_YEARS), [SIDE]: build(SIDE, SIDE_YEARS) };
}

export const SYSTEM = `You write the Instagram history of a fictional creator for a test dataset. The brief below is the only
source of truth about her. Everything you write is invented: no real people, no real brands, no real
accounts. Keep it flirty at most, never explicit.

Write the way real Instagram reads: short, uneven, casual. Fan comments vary in length, tone and spelling;
some are one emoji, some are questions, a few are rude or creepy. Her replies follow the voice section
exactly and change with the timeline. Do not reuse a caption, comment or reply.`;

export function batchPrompt(slots) {
  const spec = slots.map((s) => ({
    key: `${s.account}:${s.index}`,
    account: s.account,
    date: s.date.slice(0, 10),
    type: s.type,
    ...(s.collab_owner ? { collab_owner: s.collab_owner } : {}),
    ...(s.empty_caption ? { empty_caption: true } : {}),
    replies: s.pairs,
    ...(s.top_level ? { her_top_level_comments: s.top_level } : {}),
  }));
  return `Write these ${slots.length} posts. For each post:

- caption: her caption, in her voice for that date. When empty_caption is true, "". When collab_owner is
  set, the caption is written by that brand account in a brand voice, not hers.
- hashtags: 0 to 4, mostly 0.
- location: a place name or null (mostly null).
- description: one sentence describing the cover image or first frame, as an alt-text writer would.
- replies: exactly the number asked. Each is {"fan": the fan's comment, "her": her reply to it}. Do not
  start her reply with an @handle; it is added later. A fan comment may be "[GIF]" a few times in the
  whole batch, meaning the fan sent a GIF.
- top_level: when her_top_level_comments is set, that many comments she left on her own post, else [].

Posts (account "${SIDE}" is her film-photo side account):
${JSON.stringify(spec, null, 1)}

Answer with JSON only, no prose and no code fence:
{"posts":[{"key":"...","caption":"...","hashtags":[],"location":null,"description":"...","replies":[{"fan":"...","her":"..."}],"top_level":[]}]}`;
}

/** Parses Claude's batch answer and checks it covers every slot with the counts asked. */
export function parseBatch(text, slots) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no json object in answer");
  const json = JSON.parse(text.slice(start, end + 1));
  const byKey = new Map((json.posts ?? []).map((p) => [p.key, p]));
  for (const s of slots) {
    const p = byKey.get(`${s.account}:${s.index}`);
    if (!p) throw new Error(`missing post ${s.account}:${s.index}`);
    if (!Array.isArray(p.replies) || p.replies.length < s.pairs) throw new Error(`short replies on ${s.account}:${s.index}`);
  }
  return byKey;
}

const minutesAfter = (iso, minutes) => new Date(Date.parse(iso) + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Joins the skeleton with Claude's words into scraper records. Code adds what the scraper would see:
 * the fan's handle, her `@handle` prefix, reply timestamps, the pairing basis (grid index below the
 * cut-off was "scraped before the fix", so its pairing is thread-first), and GIF replies of her own.
 */
export function assemble(slots, words, seed) {
  const rng = seededRng(`${seed}:assemble:${slots[0]?.account}`);
  const threadFirstBelow = Math.floor(slots.length * 0.45);
  return slots.map((s) => {
    const w = words.get(`${s.account}:${s.index}`);
    const url = `https://www.instagram.com/${s.type === "reel" ? "reel" : "p"}/${s.shortcode}/`;
    const herComments = [];
    let t = 20 + Math.floor(rng() * 300);
    for (const pair of w.replies.slice(0, s.pairs)) {
      const fan = fanHandle(rng);
      const fanGif = /^\s*\[gif\]\s*$/i.test(pair.fan);
      const herGif = rng() < 0.04;
      t += 1 + Math.floor(rng() * 240);
      herComments.push({
        kind: "reply",
        date: minutesAfter(s.date, t),
        text: herGif ? "" : `@${fan} ${pair.her}`,
        ...(herGif ? { non_text: true } : {}),
        replying_to_user: fan,
        replying_to_text: fanGif ? "" : pair.fan,
        ...(fanGif ? { replying_to_non_text: true } : {}),
        replying_to_basis: s.index < threadFirstBelow ? "thread_root" : "replied_to_comment_id",
        likes: Math.floor(rng() * 12),
      });
    }
    for (const text of (w.top_level ?? []).slice(0, s.top_level)) {
      t += 5 + Math.floor(rng() * 600);
      herComments.push({ kind: "top_level", date: minutesAfter(s.date, t), text, non_text: false, likes: Math.floor(rng() * 40) });
    }
    const plays = s.type === "reel" ? Math.floor(800 + rng() * (s.date < "2024" ? 6000 : 60000)) : null;
    return {
      index: s.index,
      url,
      shortcode: s.shortcode,
      type: s.type,
      date: s.date,
      caption: s.empty_caption ? "" : w.caption,
      post_owner: s.collab_owner ?? s.account,
      ...(s.pinned ? { pinned: true } : {}),
      ...(s.collab_owner ? { caption_author_note: `collab owned by ${s.collab_owner}; caption is theirs` } : {}),
      found_in: "profile_grid",
      hashtags: w.hashtags ?? [],
      mentions: [],
      tagged_users: [],
      collab_coauthors: s.collab_owner ? [s.account] : [],
      location: w.location ?? null,
      like_count: null,
      comment_count: herComments.length * 3 + Math.floor(rng() * 20),
      play_count: plays,
      description: w.description ?? "",
      her_comments: herComments,
      synthetic: true,
    };
  });
}

const PROFILES = {
  [MAIN]: {
    handle: MAIN,
    display_name: "juno",
    category: "Artist",
    bio: "brighton 🌊 skates, swims, sets\n@junofilm for the film ones\nbiscuit's assistant",
    links: [{ text: "my page", url: "https://example.com/junovale" }],
    followers: 84213,
    following: 512,
  },
  [SIDE]: {
    handle: SIDE,
    display_name: "juno on film",
    category: "Photographer",
    bio: "35mm, badly. main: @junovale",
    links: [],
    followers: 6120,
    following: 88,
  },
};

function notes(handle, posts) {
  const replies = posts.flatMap((p) => p.her_comments).filter((c) => c.kind === "reply");
  const count = (f) => replies.filter(f).length;
  return `# ${handle}: synthetic creator notes

**This account does not exist.** Every record was generated by \`scripts/persona/synth.mjs\` from
\`scripts/persona/synth-brief.md\`: code chose the structure, Claude wrote the words. It has the exact shape of
a real scrape so the pipeline runs unchanged.

| | |
|---|---|
| Posts | ${posts.length} |
| Empty captions | ${posts.filter((p) => p.caption === "").length} |
| Collab captions (not her voice) | ${posts.filter((p) => p.caption_author_note).length} |
| Her replies | ${replies.length} (exact ${count((c) => c.replying_to_basis === "replied_to_comment_id")}, thread-first ${count((c) => c.replying_to_basis === "thread_root")}) |
| Her GIF replies | ${count((c) => c.non_text)} |
| Fan GIF comments she answered | ${count((c) => c.replying_to_non_text)} |
| Her top-level comments | ${posts.flatMap((p) => p.her_comments).filter((c) => c.kind === "top_level").length} |
`;
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

export async function synth({ model, briefPath, outDir, seed, budget, concurrency, claude }) {
  const brief = readFileSync(briefPath, "utf8");
  const plan = skeleton(seed);
  const cacheDir = join(outDir, ".synth-cache");
  mkdirSync(cacheDir, { recursive: true });

  const slots = [...plan[MAIN], ...plan[SIDE]];
  const batches = [];
  for (let i = 0; i < slots.length; i += 12) batches.push(slots.slice(i, i + 12));

  const words = new Map();
  await pool(batches, concurrency, async (batch, i) => {
    const cache = join(cacheDir, `batch-${String(i).padStart(3, "0")}.json`);
    if (existsSync(cache)) {
      for (const [k, v] of parseBatch(readFileSync(cache, "utf8"), batch)) words.set(k, v);
      return;
    }
    for (let attempt = 1; ; attempt++) {
      const res = await claude.complete({ model, system: `${SYSTEM}\n\n${brief}`, prompt: batchPrompt(batch), maxTokens: 16000 });
      budget.addClaude(res.usage);
      try {
        const parsed = parseBatch(res.text, batch);
        writeFileSync(cache, res.text);
        for (const [k, v] of parsed) words.set(k, v);
        console.log(`batch ${i + 1}/${batches.length} ok (${budget.used} tokens so far)`);
        return;
      } catch (err) {
        if (attempt >= 2) throw new Error(`batch ${i}: ${err.message}`);
        console.log(`batch ${i + 1} malformed (${err.message}), retrying`);
      }
    }
  });

  for (const handle of [MAIN, SIDE]) {
    const posts = assemble(plan[handle], words, seed);
    const dir = join(outDir, handle);
    mkdirSync(dir, { recursive: true });
    writeJsonl(join(dir, "posts.jsonl"), posts);
    writeJson(join(dir, "profile.json"), {
      ...PROFILES[handle],
      url: `https://www.instagram.com/${handle}/`,
      posts: posts.length,
      captured_at: CAPTURED,
      synthetic: true,
    });
    writeFileSync(join(dir, "NOTES.md"), notes(handle, posts));
  }
  return { posts: slots.length, tokens: budget.used };
}

if (isMain(import.meta.url)) {
  loadEnvFile(".env.local");
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.model !== "string") throw new Error("--model <id> is required");
  const result = await synth({
    model: args.model,
    briefPath: args.brief ?? "scripts/persona/synth-brief.md",
    outDir: args.out ?? "data/persona/raw",
    seed: args.seed ?? "juno-2026",
    budget: new TokenBudget(Number(args.budget ?? 1_500_000)),
    concurrency: Number(args.concurrency ?? 4),
    claude: createClaude(),
  });
  console.log(JSON.stringify(result));
}
