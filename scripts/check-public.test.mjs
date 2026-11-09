import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-public.mjs");
// Built from parts so this file does not trip the check it tests.
const DECISION = ["D", "044"].join("-");
const PR_REF = ["PR", "12"].join(" ");
const PRIVATE_DIR = [".prod", "uct/"].join("");

function repo(files, { track = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "check-public-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  if (track) execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

const run = (dir) => spawnSync("node", [SCRIPT, dir], { encoding: "utf8" });

test("an id, a PR number or a private path in a tracked file fails with file:line", () => {
  const cases = [`// see ${DECISION}`, `// added in ${PR_REF}`, `// notes in ${PRIVATE_DIR}plans`];
  for (const body of cases) {
    const r = run(repo({ "lib/a.ts": `const x = 1;\n${body}\n` }));
    assert.equal(r.status, 1, body);
    assert.match(r.stdout, /public: 1 hits/);
    assert.match(r.stdout, /lib\/a\.ts:2:/);
  }
});

test("the same text under the private tree passes", () => {
  const r = run(repo({ [`${PRIVATE_DIR}DECISIONS.md`]: `${DECISION} ${PR_REF}\n` }));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /public: 0 hits/);
});

test("an allow-listed path passes", () => {
  const r = run(repo({ "scripts/gate.sh": `# ${PRIVATE_DIR}gate-steps\n`, "lib/ok.ts": "const x = 1;\n" }));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /public: 0 hits/);
});

test("a docs page is not allow-listed", () => {
  const r = run(repo({ "docs/notes.md": `${DECISION}\n` }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /docs\/notes\.md:1/);
});

test("an untracked file is not scanned", () => {
  const r = run(repo({ "lib/a.ts": `// ${DECISION}\n` }, { track: false }));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /public: 0 hits/);
});
