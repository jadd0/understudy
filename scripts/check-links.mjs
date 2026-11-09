// Every relative link and image in a tracked markdown file must resolve to a file or folder in the repository.
// Anchors and external URLs are not checked. Run from the repo root: node scripts/check-links.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|^\s*\[[^\]]+\]:\s*<?(\S+?)>?\s*$/gm;

/** The broken relative targets in one markdown text: [{ line, target }]. Fenced code is skipped. */
export function brokenLinks(markdown, fromDir, exists = existsSync) {
  const out = [];
  let fenced = false;
  markdown.split("\n").forEach((text, i) => {
    if (/^\s*(```|~~~)/.test(text)) fenced = !fenced;
    if (fenced) return;
    for (const m of text.matchAll(LINK)) {
      const raw = m[1] ?? m[2];
      if (!raw || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) continue;
      let target = raw.split("#")[0].split("?")[0];
      if (!target) continue;
      try { target = decodeURIComponent(target); } catch { /* use as written */ }
      if (!exists(path.resolve(fromDir, target))) out.push({ line: i + 1, target: raw });
    }
  });
  return out;
}

function main() {
  const files = execFileSync("git", ["ls-files", "*.md"], { encoding: "utf8" }).split("\n").filter(Boolean);
  let bad = 0;
  for (const f of files) {
    for (const { line, target } of brokenLinks(readFileSync(f, "utf8"), path.dirname(path.resolve(f)))) {
      console.error(`${f}:${line}: broken link ${target}`);
      bad++;
    }
  }
  console.log(`links: ${files.length} markdown files, ${bad} broken`);
  process.exit(bad ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
