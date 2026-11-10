import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { expandHome, leakCheck, loadNames, main, maskNames, nameCheck } from "./leak-check.mjs";

const RAW = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "raw");

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), "leak-tree-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

const run = (env, dir, opts) => {
  const lines = [];
  const code = main(env, dir, false, (l) => lines.push(l), undefined, opts);
  return { code, lines };
};

// the raw check's own lines; the names check prints its own after them
const rawLines = (lines) => lines.filter((l) => !l.startsWith("names:"));

test("a tree holding a 6-word run of a raw caption or reply is flagged", () => {
  // caption "HELLO world :3" is too short, so the run comes from the description and a reply's text
  const description = tree({ "docs/a.md": "She wrote: Selfie with @bobby in a car, near the sea." });
  const reply = tree({ "docs/b.md": "Quoted: you look great @dave.x honestly" });
  for (const dir of [description, reply]) {
    const r = leakCheck(RAW, dir);
    assert.ok(r.shingles > 0);
    assert.ok(r.hits > 0, "expected a hit");
    const out = run({ LEAK_CHECK_RAW: RAW }, dir);
    assert.equal(out.code, 1);
    for (const l of out.lines) assert.ok(l.length < 120, "a printed line stays short");
  }
});

test("a tree holding a raw handle of 5+ characters is flagged", () => {
  const dir = tree({ "src/x.ts": "// thanks to carol_fan for the idea" });
  const r = leakCheck(RAW, dir);
  assert.deepEqual([...r.perFile.values()].flat(), ["handle: carol_fan"]);
  assert.equal(run({ LEAK_CHECK_RAW: RAW }, dir).code, 1);
});

test("a clean tree passes", () => {
  const dir = tree({ "README.md": "Juno is a synthetic creator.\nNothing here comes from a scrape." });
  const r = leakCheck(RAW, dir);
  assert.ok(r.handles > 0 && r.shingles > 0);
  assert.equal(r.hits, 0);
  const out = run({ LEAK_CHECK_RAW: RAW }, dir);
  assert.equal(out.code, 0);
  assert.match(rawLines(out.lines).at(-1), /^leak: files=0 hits=0 /);
});

test("unset or missing LEAK_CHECK_RAW skips with exit 0", () => {
  const dir = tree({ "a.md": "Selfie with @bobby in a car" });
  for (const env of [{}, { LEAK_CHECK_RAW: join(tmpdir(), "no-such-raw-dir-xyz") }]) {
    const out = run(env, dir);
    assert.equal(out.code, 0);
    assert.match(out.lines[0], /^leak: skipped \(/);
  }
});

test("the scan skips .git, node_modules, .next, .claude, package-lock.json, binaries and the raw dir itself", () => {
  const leak = "Selfie with @bobby in a car";
  const skipped = {
    ".git/c": leak,
    "node_modules/m/i.js": leak,
    ".next/b.js": leak,
    ".claude/worktrees/w/a.md": leak,
    "package-lock.json": leak,
    "img/p.png": leak,
  };
  // the raw dir sits inside the tree it is checked against, and holds the leaking text itself
  const withRaw = (files) => {
    const dir = tree(files);
    cpSync(RAW, join(dir, "private-raw"), { recursive: true });
    return dir;
  };
  const dir = withRaw({ ...skipped, "kept.md": "nothing to see" });
  const r = leakCheck(join(dir, "private-raw"), dir);
  assert.ok(r.shingles > 0);
  assert.equal(r.hits, 0);
  // the same text in a scanned path is flagged, so the skips above are what kept the count at 0
  const visible = withRaw({ ...skipped, "docs/seen.md": leak });
  const v = leakCheck(join(visible, "private-raw"), visible);
  assert.deepEqual([...v.perFile.keys()], ["docs/seen.md"]);
});

test("a LEAK_CHECK_RAW starting with ~/ is read from the home directory, not skipped", () => {
  const home = mkdtempSync(join(tmpdir(), "leak-home-"));
  cpSync(RAW, join(home, ".understudy", "raw"), { recursive: true });
  assert.equal(expandHome("~/.understudy/raw", home), join(home, ".understudy", "raw"));
  assert.equal(expandHome("~", home), home);
  assert.equal(expandHome("/abs/~/x", home), "/abs/~/x");
  const dir = tree({ "src/x.ts": "// thanks to carol_fan for the idea" });
  const lines = [];
  const code = main({ LEAK_CHECK_RAW: "~/.understudy/raw" }, dir, false, (l) => lines.push(l), home);
  assert.equal(code, 1);
  assert.ok(!lines.some((l) => l.startsWith("leak: skipped")), lines.join("\n"));
  assert.match(rawLines(lines).at(-1), /^leak: files=1 hits=1 /);
});

// --- private names: LEAK_CHECK_NAMES ---

/** A git checkout holding `tracked` (added to the index) and `untracked` files. */
function repo(tracked, untracked = {}) {
  const dir = tree({ ...tracked, ...untracked });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "--", ...Object.keys(tracked)], { cwd: dir });
  return dir;
}

/** A names file holding `body`, returned as the path. */
function namesFile(body) {
  const dir = mkdtempSync(join(tmpdir(), "leak-names-"));
  writeFileSync(join(dir, "names.txt"), body);
  return join(dir, "names.txt");
}

const TERMS = "# private terms\nZorbleton\nQuillan Fenwick  # two words\nab\n\n";

test("loadNames drops comments, blank lines and terms under 3 characters", () => {
  assert.deepEqual(loadNames(namesFile(TERMS)), ["Zorbleton", "Quillan Fenwick"]);
});

test("a name in a tracked file is caught whatever its case, and a two-word term with a space, a hyphen or neither", () => {
  const terms = ["Zorbleton", "Quillan Fenwick"];
  const dir = repo({
    "docs/a.md": "fine line\nthe founder met ZORBLETON once\n",
    "docs/b.md": "by quillan fenwick\n",
    "docs/c.md": "by Quillan-Fenwick\n",
    "docs/d.md": "by QuillanFenwick\n",
    "docs/clean.md": "Juno Vale is fictional.\n",
  });
  const r = nameCheck(terms, dir);
  assert.deepEqual([...r.perFile.keys()].sort(), ["docs/a.md", "docs/b.md", "docs/c.md", "docs/d.md"]);
  assert.deepEqual(r.perFile.get("docs/a.md"), [{ line: 2, length: 9 }]);
  assert.equal(r.hits, 4);
});

test("a term inside a longer word is not a hit", () => {
  const dir = repo({ "a.md": "Zorbletonian and unZorbleton and Zorbleton2\n" });
  assert.equal(nameCheck(["Zorbleton"], dir).hits, 0);
});

test("an untracked file is never name-scanned, and neither is .env.local", () => {
  const dir = repo({ "kept.md": "nothing here\n" }, { "scratch.md": "Zorbleton\n", ".env.local": "OWNER=Zorbleton\n" });
  const r = nameCheck(["Zorbleton"], dir);
  assert.equal(r.hits, 0);
  assert.equal(r.files, 0);
});

test("a tracked .env file is skipped and a tracked file named with the term is caught by its path", () => {
  const dir = repo({ ".env.example": "OWNER=Zorbleton\n", "docs/zorbleton-notes.md": "clean body\n" });
  const r = nameCheck(["Zorbleton"], dir);
  assert.deepEqual(r.perFile, new Map([["docs/zorbleton-notes.md", [{ line: 0, length: 9 }]]]));
});

test("a tree that is not a git checkout is walked, still without .env files and node_modules", () => {
  const dir = tree({ "src/a.ts": "// Zorbleton", ".env.local": "Zorbleton", "node_modules/x/i.js": "Zorbleton" });
  assert.deepEqual([...nameCheck(["Zorbleton"], dir).perFile.keys()], ["src/a.ts"]);
});

test("a name hit exits 1 and prints file:line and a length, never the term", () => {
  const dir = repo({ "docs/a.md": "x\nquillan fenwick wrote this\n", "docs/zorbleton.md": "ok\n" });
  const out = run({ LEAK_CHECK_NAMES: namesFile(TERMS) }, dir);
  assert.equal(out.code, 1);
  assert.ok(out.lines.includes("docs/a.md:2 (15 chars)"), out.lines.join("\n"));
  assert.ok(out.lines.includes("docs/*********.md (path, 9 chars)"), out.lines.join("\n"));
  assert.equal(out.lines.at(-1), "names: 2 hits");
  assert.ok(!/zorbleton|quillan|fenwick/i.test(out.lines.join("\n")), "a printed line holds a term");
  assert.equal(maskNames("a/Quillan-Fenwick/zorbleton.md", ["Zorbleton", "Quillan Fenwick"]), "a/***************/*********.md");
});

test("the names check runs with no raw directory, and a clean tree passes", () => {
  const dir = repo({ "README.md": "Juno Vale is synthetic.\n" });
  const out = run({ LEAK_CHECK_NAMES: namesFile(TERMS) }, dir);
  assert.equal(out.code, 0);
  assert.deepEqual(out.lines, ["leak: skipped (LEAK_CHECK_RAW is not set)", "names: 0 hits"]);
});

test("without --require an unset names variable skips the names check", () => {
  const dir = repo({ "README.md": "Zorbleton\n" });
  const out = run({ LEAK_CHECK_RAW: RAW }, dir);
  assert.equal(out.code, 0);
  assert.equal(out.lines.at(-1), "names: skipped (LEAK_CHECK_NAMES is not set)");
});

test("--require exits 2 when either variable is unset, the names file is empty or the raw directory has no text", () => {
  const dir = repo({ "README.md": "Juno Vale is synthetic.\n" });
  const names = namesFile(TERMS);
  const good = run({ LEAK_CHECK_RAW: RAW, LEAK_CHECK_NAMES: names }, dir, { require: true });
  assert.equal(good.code, 0);
  assert.match(rawLines(good.lines).at(-1), /^leak: files=0 hits=0 .* shingles=[1-9]/);
  assert.equal(good.lines.at(-1), "names: 0 hits");

  const emptyNames = namesFile("# nothing here\nab\n");
  const emptyRaw = mkdtempSync(join(tmpdir(), "leak-empty-raw-"));
  for (const env of [
    { LEAK_CHECK_NAMES: names },
    { LEAK_CHECK_RAW: RAW },
    { LEAK_CHECK_RAW: RAW, LEAK_CHECK_NAMES: emptyNames },
    { LEAK_CHECK_RAW: RAW, LEAK_CHECK_NAMES: join(tmpdir(), "no-such-names-file") },
    { LEAK_CHECK_RAW: join(tmpdir(), "no-such-raw-dir-xyz"), LEAK_CHECK_NAMES: names },
    { LEAK_CHECK_RAW: emptyRaw, LEAK_CHECK_NAMES: names },
  ]) {
    assert.equal(run(env, dir, { require: true }).code, 2, JSON.stringify(Object.keys(env)));
    assert.equal(run(env, dir).code, 0, "the same inputs only skip without --require");
  }
});

test("--require with a raw leak or a name hit still reports it", () => {
  const dir = repo({ "docs/a.md": "Zorbleton\n" });
  const out = run({ LEAK_CHECK_RAW: RAW, LEAK_CHECK_NAMES: namesFile(TERMS) }, dir, { require: true });
  assert.equal(out.code, 1);
  assert.equal(out.lines.at(-1), "names: 1 hits");
});
