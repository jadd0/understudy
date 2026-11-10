// Flags any text in a tree that comes from a private raw scrape: 6-word shingles of captions, the
// creator's comments, the comments she replied to and descriptions, plus every handle seen in it.
// The repo is public, so a copied sentence with no name on it must still be caught.
//   understudy-persona leak-check [--summary] [--require]
// LEAK_CHECK_RAW (read from the environment or .env.local; a leading ~/ is the home directory) names the private raw directory, one
// folder per handle with profile.json and posts.jsonl. Unset or missing: the step skips and exits 0
// so a clone without the scrape still gates. The tree is the current directory. Nothing is written,
// and a hit prints at most its 6-word shingle.
// LEAK_CHECK_NAMES names a second private file: one term per line (a company, a creator, anything that must not
// appear in a public file; `#` starts a comment, terms under 3 characters are ignored, a leading ~/ is the home
// directory). The tree's file contents and paths are matched against it, case-insensitively and on word
// boundaries, with a space or hyphen inside a term optional. A hit prints file:line and the matched text's length,
// never the term (a path that holds one is printed with the match starred out). Both checks need their variable to run unless --require is given: then an unset or empty input
// (no raw directory, no names file, no terms, no shingles) exits 2 instead of passing.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
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

const MIN_TERM = 3;

/** The terms in a names file: one per line, `#` comments and blank lines dropped, short terms ignored. */
export function loadNames(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter((t) => t.length >= MIN_TERM);
}

/** One regex for all terms: word-bounded, case-insensitive, a space or hyphen inside a term optional. */
export function nameRegex(terms) {
  const alt = terms.map((t) =>
    t
      .split(/[\s-]+/)
      .filter(Boolean)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[\\s-]?"),
  );
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt.join("|")})(?![\\p{L}\\p{N}])`, "iu");
}

/** `text` with every match of a term replaced by asterisks of the same length, so a path can be printed safely. */
export function maskNames(text, terms) {
  const re = nameRegex(terms);
  return text.replace(new RegExp(re.source, "giu"), (m) => "*".repeat(m.length));
}

/** The files to scan for names: the tracked files when `tree` is a git checkout, else a walk. Never `.env*`. */
function namedFiles(tree) {
  const files = existsSync(join(tree, ".git"))
    ? execFileSync("git", ["ls-files", "-z"], { cwd: tree, encoding: "utf8", maxBuffer: 1 << 28 }).split("\0").filter(Boolean)
    : walk(tree, new Set()).map((f) => relative(tree, f));
  return files.filter((f) => !basename(f).startsWith(".env"));
}

/**
 * Scans the contents and paths of `tree`'s files for the terms in `terms`.
 * Returns { files, hits, perFile } where each hit is { line, length } (line 0 for a path).
 */
export function nameCheck(terms, tree) {
  const re = nameRegex(terms);
  const perFile = new Map();
  for (const f of namedFiles(tree)) {
    const hits = [];
    const inPath = f.match(re);
    if (inPath) hits.push({ line: 0, length: inPath[0].length });
    if (!BINARY.test(f) && !SKIP_FILES.has(basename(f))) {
      let text = null;
      try {
        text = readFileSync(join(tree, f), "utf8");
      } catch {
        // deleted but still indexed, or unreadable: nothing to scan
      }
      if (text !== null && !text.includes("\0")) {
        text.split("\n").forEach((line, i) => {
          const m = line.match(re);
          if (m) hits.push({ line: i + 1, length: m[0].length });
        });
      }
    }
    if (hits.length) perFile.set(f, hits);
  }
  const total = [...perFile.values()].reduce((n, h) => n + h.length, 0);
  return { files: perFile.size, hits: total, perFile };
}

/**
 * Runs the check as the gate step does; returns the exit code: 0 clean or skipped, 1 a hit, 2 a missing input
 * under `require`.
 */
export function main(env, tree, summary, out = console.log, home = homedir(), { require = false } = {}) {
  let code = 0;

  const raw = env.LEAK_CHECK_RAW;
  const rawDir = raw ? resolve(expandHome(raw, home)) : null;
  const rawUsable = rawDir !== null && existsSync(rawDir) && statSync(rawDir).isDirectory();
  if (!raw) {
    out(require ? "leak: LEAK_CHECK_RAW is not set" : "leak: skipped (LEAK_CHECK_RAW is not set)");
    if (require) code = 2;
  } else if (!rawUsable) {
    out(require ? "leak: LEAK_CHECK_RAW does not point at a directory" : "leak: skipped (LEAK_CHECK_RAW does not point at a directory)");
    if (require) code = 2;
  } else {
    const r = leakCheck(rawDir, tree);
    for (const [f, hits] of [...r.perFile].sort((a, b) => b[1].length - a[1].length)) {
      out(`${String(hits.length).padStart(5)}  ${f}`);
      if (!summary) for (const h of [...new Set(hits)].slice(0, 5)) out(`         ${h}`);
    }
    out(`leak: files=${r.files} hits=${r.hits} handles=${r.handles} shingles=${r.shingles}`);
    if (require && r.shingles === 0) {
      out("leak: the raw directory holds no text, so the check proved nothing");
      code = 2;
    } else if (r.hits > 0) code = 1;
  }

  const names = env.LEAK_CHECK_NAMES;
  const namesFile = names ? resolve(expandHome(names, home)) : null;
  const terms = namesFile !== null && existsSync(namesFile) && statSync(namesFile).isFile() ? loadNames(namesFile) : [];
  if (terms.length === 0) {
    const why = !names ? "LEAK_CHECK_NAMES is not set" : "LEAK_CHECK_NAMES does not name a file with terms";
    out(require ? `names: ${why}` : `names: skipped (${why})`);
    if (require) code = 2;
  } else {
    const r = nameCheck(terms, tree);
    for (const [f, hits] of [...r.perFile].sort((a, b) => b[1].length - a[1].length)) {
      for (const h of hits.slice(0, 5)) out(h.line === 0 ? `${maskNames(f, terms)} (path, ${h.length} chars)` : `${f}:${h.line} (${h.length} chars)`);
    }
    out(`names: ${r.hits} hits`);
    if (r.hits > 0 && code === 0) code = 1;
  }
  return code;
}

if (isMain(import.meta.url)) {
  loadEnvFile(".env.local");
  const args = process.argv.slice(2);
  process.exit(main(process.env, process.cwd(), args.includes("--summary"), console.log, homedir(), { require: args.includes("--require") }));
}
