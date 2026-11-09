import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { leakCheck, main } from "./leak-check.mjs";

const RAW = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "raw");

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), "leak-tree-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

const run = (env, dir) => {
  const lines = [];
  const code = main(env, dir, false, (l) => lines.push(l));
  return { code, lines };
};

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
  assert.match(out.lines.at(-1), /^leak: files=0 hits=0 /);
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
