// Flags any text in a tree that comes from a private raw scrape: 6-word shingles of captions, the
// creator's comments, the comments she replied to and descriptions, plus every handle seen in it.
// The repo is public, so a copied sentence with no name on it must still be caught.
//   understudy-persona leak-check [--summary]
// LEAK_CHECK_RAW (read from the environment or .env.local; a leading ~/ is the home directory) names the private raw directory, one
// folder per handle with profile.json and posts.jsonl. Unset or missing: the step skips and exits 0
// so a clone without the scrape still gates. The tree is the current directory. Nothing is written,
// and a hit prints at most its 6-word shingle.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { isMain, loadEnvFile } from "./lib/io.mjs";

const N = 6;
const SKIP_DIRS = new Set([".git", "node_modules", ".next", ".claude"]);
const SKIP_FILES = new Set(["package-lock.json"]);
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|otf|mp4|mov|zip|gz)$/i;
// Handles too generic to mean anything on their own.
const GENERIC_HANDLES = ["user", "gmail.com"];

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}@._ ]+/gu, " ").replace(/\s+/g, " ").trim();
const words = (s) => norm(s).split(" ").filter(Boolean);

/** Reads every handle folder under rawDir into { shingles: Map(shingle -> source), handles: Set }. */
export function loadRaw(rawDir) {
  const shingles = new Map();
  const handles = new Set();
  const addText = (t, src) => {
    if (typeof t !== "string") return;
    for (const m of t.matchAll(/@([a-z0-9._]{3,30})/gi)) handles.add(m[1].toLowerCase().replace(/\.$/, ""));
    const w = words(t);
    for (let i = 0; i + N <= w.length; i++) shingles.set(w.slice(i, i + N).join(" "), src);
  };
  for (const h of readdirSync(rawDir)) {
    const dir = join(rawDir, h);
    if (!statSync(dir).isDirectory()) continue;
    handles.add(h.toLowerCase());
    if (existsSync(join(dir, "profile.json"))) addText(JSON.parse(readFileSync(join(dir, "profile.json"), "utf8")).bio, "bio");
    if (!existsSync(join(dir, "posts.jsonl"))) continue;
    for (const line of readFileSync(join(dir, "posts.jsonl"), "utf8").split("\n").filter(Boolean)) {
      const p = JSON.parse(line);
      addText(p.caption, "caption");
      addText(p.description, "description");
      for (const u of [p.post_owner, ...(p.tagged_users ?? []), ...(p.collab_coauthors ?? [])]) if (u) handles.add(u.toLowerCase());
      for (const c of p.her_comments ?? []) {
        addText(c.text, "her_comment");
        addText(c.replying_to_text, "fan_comment");
        if (c.replying_to_user) handles.add(c.replying_to_user.toLowerCase());
      }
    }
  }
  for (const h of GENERIC_HANDLES) handles.delete(h);
  return { shingles, handles };
}

function walk(dir, skipAbs) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) || skipAbs.has(resolve(p)) ? [] : walk(p, skipAbs);
    return SKIP_FILES.has(e.name) || BINARY.test(e.name) ? [] : [p];
  });
}

/** Scans `tree` against the scrape at `rawDir`. Returns { files, hits, handles, shingles, perFile }. */
export function leakCheck(rawDir, tree) {
  const { shingles, handles } = loadRaw(rawDir);
  const long = [...handles].filter((h) => h.length >= 5).map((h) => h.replace(/[.]/g, "\\."));
  const handleRe = long.length ? new RegExp(`(^|[^a-z0-9._])(${long.join("|")})(?![a-z0-9_])`, "i") : null;
  const perFile = new Map();
  for (const f of walk(tree, new Set([resolve(rawDir)]))) {
    let text;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const hits = [];
    const w = words(text);
    const seen = new Set();
    for (let i = 0; i + N <= w.length; i++) {
      const s = w.slice(i, i + N).join(" ");
      if (shingles.has(s) && !seen.has(s)) {
        seen.add(s);
        hits.push(`text[${shingles.get(s)}]: ${s}`);
      }
    }
    if (handleRe) {
      for (const line of text.split("\n")) {
        const m = line.match(handleRe);
        if (m) hits.push(`handle: ${m[2]}`);
      }
    }
    if (hits.length) perFile.set(relative(tree, f), hits);
  }
  const total = [...perFile.values()].reduce((n, h) => n + h.length, 0);
  return { files: perFile.size, hits: total, handles: handles.size, shingles: shingles.size, perFile };
}

/** A leading `~/` (or a bare `~`) is the home directory: no shell expands it inside a .env file. */
export function expandHome(path, home = homedir()) {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/** Runs the check as the gate step does; returns the exit code. */
export function main(env, tree, summary, out = console.log, home = homedir()) {
  const raw = env.LEAK_CHECK_RAW;
  if (!raw) {
    out("leak: skipped (LEAK_CHECK_RAW is not set)");
    return 0;
  }
  const rawDir = resolve(expandHome(raw, home));
  if (!existsSync(rawDir) || !statSync(rawDir).isDirectory()) {
    out("leak: skipped (LEAK_CHECK_RAW does not point at a directory)");
    return 0;
  }
  const r = leakCheck(rawDir, tree);
  for (const [f, hits] of [...r.perFile].sort((a, b) => b[1].length - a[1].length)) {
    out(`${String(hits.length).padStart(5)}  ${f}`);
    if (!summary) for (const h of [...new Set(hits)].slice(0, 5)) out(`         ${h}`);
  }
  out(`leak: files=${r.files} hits=${r.hits} handles=${r.handles} shingles=${r.shingles}`);
  return r.hits === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) {
  loadEnvFile(".env.local");
  process.exit(main(process.env, process.cwd(), process.argv.includes("--summary")));
}
