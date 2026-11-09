// Flags any text in a tree that comes from the private raw scrape: 6-word shingles of captions,
// her comments, the comments she replied to, descriptions; plus every handle seen in the scrape.
// Usage: node leakcheck.mjs <rawDir> <treeDir> [--summary]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const [rawDir, tree] = process.argv.slice(2);
const summary = process.argv.includes("--summary");
const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}@._ ]+/gu, " ").replace(/\s+/g, " ").trim();
const N = 6;
const shingles = new Map();
const handles = new Set();
const addText = (t, src) => {
  if (typeof t !== "string") return;
  for (const m of t.matchAll(/@([a-z0-9._]{3,30})/gi)) handles.add(m[1].toLowerCase().replace(/\.$/, ""));
  const w = norm(t).split(" ").filter(Boolean);
  for (let i = 0; i + N <= w.length; i++) shingles.set(w.slice(i, i + N).join(" "), src);
};
for (const h of readdirSync(rawDir)) {
  const dir = join(rawDir, h);
  if (!statSync(dir).isDirectory()) continue;
  handles.add(h.toLowerCase());
  const prof = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
  addText(prof.bio, "bio");
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
// Handles too generic to mean anything on their own.
for (const h of ["user", "gmail.com"]) handles.delete(h);
const handleRe = new RegExp(`(^|[^a-z0-9._])(${[...handles].filter((h) => h.length >= 5).map((h) => h.replace(/[.]/g, "\\.")).join("|")})(?![a-z0-9_])`, "i");

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  if ([".git", "node_modules", ".next", "package-lock.json"].includes(e.name)) return [];
  const p = join(d, e.name);
  return e.isDirectory() ? walk(p) : [p];
});
const perFile = new Map();
for (const f of walk(tree)) {
  if (/\.(png|jpg|jpeg|gif|webp|ico|pdf|woff2?)$/i.test(f)) continue;
  const text = readFileSync(f, "utf8");
  const hits = [];
  const w = norm(text).split(" ").filter(Boolean);
  const seen = new Set();
  for (let i = 0; i + N <= w.length; i++) {
    const s = w.slice(i, i + N).join(" ");
    if (shingles.has(s) && !seen.has(s)) { seen.add(s); hits.push(`text[${shingles.get(s)}]: ${s}`); }
  }
  for (const line of text.split("\n")) {
    const m = line.match(handleRe);
    if (m) hits.push(`handle: ${m[2]}`);
  }
  if (hits.length) perFile.set(relative(tree, f), hits);
}
let total = 0;
for (const [f, hits] of [...perFile].sort((a, b) => b[1].length - a[1].length)) {
  total += hits.length;
  console.log(`${String(hits.length).padStart(5)}  ${f}`);
  if (!summary) for (const h of [...new Set(hits)].slice(0, 5)) console.log(`         ${h}`);
}
console.log(`files=${perFile.size} hits=${total} handles=${handles.size} shingles=${shingles.size}`);
