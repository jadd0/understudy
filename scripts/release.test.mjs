import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PUBLISH_ARGS } from "./release.mjs";

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
