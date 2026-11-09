// Fails when a tracked file outside the private tree cites a decision id, a finding id,
// a PR number or a path into the private planning directory: a stranger reading the
// public repo cannot follow any of them.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PATTERNS = [/\bD-\d{3}\b/, /\bF-\d{3}\b/, /\.product\//, /\bPR \d+[a-z]?\b/];

// Never scanned: the private tree, lockfile, migration snapshots, binary assets.
const SKIP = [
  /^\.product\//,
  /^package-lock\.json$/,
  /^examples\/app\/drizzle\/meta\//,
  /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|otf|mp4|zip)$/i,
];

// Paths allowed to hold hits: the three loop scripts whose code opens files under the private
// directory by name.
export const ALLOW = [/^scripts\/(gate\.sh|kit-config\.mjs|verify-pr\.mjs|export-public\.sh|worktree-setup\.sh)$/, /^\.gitignore$/];

export function scan(root) {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const hits = [];
  for (const file of files) {
    if (SKIP.some((re) => re.test(file))) continue;
    let text;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    text.split("\n").forEach((line, i) => {
      if (PATTERNS.some((re) => re.test(line))) {
        hits.push({ file, line: i + 1, text: line.trim(), allowed: ALLOW.some((re) => re.test(file)) });
      }
    });
  }
  return hits;
}

export function run(root) {
  const hits = scan(root);
  const bad = hits.filter((h) => !h.allowed);
  console.log(`public: ${bad.length} hits`);
  for (const h of bad) console.log(`${h.file}:${h.line}: ${h.text.slice(0, 120)}`);
  return bad.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(run(process.argv[2] ?? process.cwd()));
}
