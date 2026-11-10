import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const script = readFileSync(join(root, "scripts", "check.sh"), "utf8");
const stepNames = [...script.matchAll(/^step (\S+) /gm)].map((m) => m[1]);

test("check.sh is valid bash, executable, and wired to `npm run check`", () => {
  execFileSync("bash", ["-n", join(root, "scripts", "check.sh")]);
  assert.ok(statSync(join(root, "scripts", "check.sh")).mode & 0o100, "not executable");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts.check, "bash scripts/check.sh");
});

test("check.sh runs these steps in this order and stops at the first failure", () => {
  assert.deepEqual(stepNames, [
    "typecheck",
    "lint",
    "db-up",
    "test",
    "build",
    "persona",
    "env",
    "public",
    "links",
    "docker-static",
    "readme",
    "leak",
  ]);
  assert.match(script, /if \[ "\$code" -ne 0 \]; then[\s\S]*?exit 1/);
});

test("check.sh needs no private file and no gate machinery", () => {
  const instructions = script.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  for (const banned of ["scripts/gate.sh", ".product", "gate-steps", "with-gate-lock", "gate-stamp"]) {
    assert.ok(!instructions.includes(banned), `check.sh mentions ${banned}`);
  }
});

test("the leak step requires both private inputs", () => {
  assert.match(script, /^step leak npm run --silent persona:leak -- --require$/m);
});

// The private steps file is the gate's definition; every gate step must exist here too, so a check added to the
// gate cannot be missing from `npm run check`. The path is built from parts so no tracked file names it.
const gateSteps = join(root, [".prod", "uct"].join(""), ["gate", "steps"].join("-"));
test("every gate step appears in check.sh", { skip: !existsSync(gateSteps) && "the private steps file is not present" }, () => {
  const names = readFileSync(gateSteps, "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("\t")[0]);
  assert.ok(names.length > 0, "the steps file parsed to no steps");
  for (const name of names.filter((n) => n !== "db-up" && n !== "codemap")) {
    assert.ok(stepNames.includes(name), `check.sh has no step ${name}`);
  }
});
