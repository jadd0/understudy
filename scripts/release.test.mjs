import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PUBLISH_ARGS, treeStatus } from "./release.mjs";

const source = readFileSync(new URL("./release.mjs", import.meta.url), "utf8");

test("the one publish call is a dry run over exactly the three packages", () => {
  assert.equal(PUBLISH_ARGS[0], "publish");
  assert.ok(PUBLISH_ARGS.includes("--dry-run"));
  const workspaces = PUBLISH_ARGS.flatMap((a, i) => (PUBLISH_ARGS[i - 1] === "-w" ? [a] : []));
  assert.deepEqual(workspaces.sort(), ["@jadd0/understudy-engine", "@jadd0/understudy-persona", "@jadd0/understudy-providers"]);
});

test("release.mjs names npm's publish command once and has no flag that drops the dry run", () => {
  assert.equal(source.split('"publish"').length - 1, 1);
  assert.doesNotMatch(source, /process\.argv\.includes|--no-dry-run|--really|--yes/);
});

test("a git status that fails to run or exits non-zero is not a clean tree", () => {
  assert.deepEqual(treeStatus(() => ({ status: 0, stdout: "", stderr: "" })), { ok: true, dirty: "" });
  assert.deepEqual(treeStatus(() => ({ status: 0, stdout: " M a.ts\n", stderr: "" })), { ok: true, dirty: "M a.ts" });
  const spawnFailed = treeStatus(() => ({ error: Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }), status: null, stdout: null, stderr: null }));
  assert.equal(spawnFailed.ok, false);
  assert.match(spawnFailed.reason, /ENOENT/);
  const exitedNonZero = treeStatus(() => ({ status: 128, stdout: "", stderr: "fatal: not a git repository\n" }));
  assert.equal(exitedNonZero.ok, false);
  assert.match(exitedNonZero.reason, /128/);
});

test("release.mjs stops before building when git cannot read the tree", () => {
  const r = spawnSync("node", [fileURLToPath(new URL("./release.mjs", import.meta.url))], { encoding: "utf8", env: { ...process.env, GIT_DIR: "/nonexistent-git-dir" }, timeout: 30_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot tell whether the working tree is clean/);
  assert.doesNotMatch(r.stdout + r.stderr, /pack-smoke: building|dry run only/);
});
