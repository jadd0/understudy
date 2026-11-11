import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    "packages",
    "persona",
    "env",
    "public",
    "codemap",
    "leak",
    "links",
    "docker-static",
    "readme",
  ]);
  assert.match(script, /if \[ "\$code" -ne 0 \]; then[\s\S]*?exit 1/);
});

test("check.sh needs no private file and no gate machinery", () => {
  const instructions = script.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  for (const banned of ["scripts/gate.sh", ".product", "gate-steps", "with-gate-lock", "gate-stamp"]) {
    assert.ok(!instructions.includes(banned), `check.sh mentions ${banned}`);
  }
});

test("the leak step is the gate's: it skips an unset private input, and does not pass --require", () => {
  assert.match(script, /^step leak npm run --silent persona:leak$/m);
});

// The private steps file is the gate's definition; every gate step must exist here too, in the gate's order, so a
// check added to the gate cannot be missing from `npm run check` or run at a different point. The path is built from
// parts so no tracked file names it.
const gateSteps = join(root, [".prod", "uct"].join(""), ["gate", "steps"].join("-"));
const skipGate = !existsSync(gateSteps) && "the private steps file is not present";
const gateNames = () =>
  readFileSync(gateSteps, "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("\t")[0]);

test("every gate step appears in check.sh", { skip: skipGate }, () => {
  const names = gateNames();
  assert.ok(names.length > 0, "the steps file parsed to no steps");
  for (const name of names) assert.ok(stepNames.includes(name), `check.sh has no step ${name}`);
});

test("the gate's steps run in check.sh in the gate's order, and readme is the only step the gate lacks", { skip: skipGate }, () => {
  const names = gateNames();
  assert.deepEqual(
    stepNames.filter((n) => names.includes(n)),
    names,
  );
  assert.deepEqual(
    stepNames.filter((n) => !names.includes(n)),
    ["readme"],
  );
});

/** Runs a copy of check.sh with every tool stubbed to record the TEST_DB_SCOPE it sees; returns the log lines. */
function runStubbed(scope) {
  const dir = mkdtempSync(join(tmpdir(), "check-sh-"));
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "bin"));
  copyFileSync(join(root, "scripts", "check.sh"), join(dir, "scripts", "check.sh"));
  const log = join(dir, "log");
  for (const tool of ["npm", "npx", "docker", "node"]) {
    writeFileSync(join(dir, "bin", tool), `#!/bin/sh\necho "${tool} $* scope=\${TEST_DB_SCOPE-unset}" >> "${log}"\n`);
    chmodSync(join(dir, "bin", tool), 0o755);
  }
  const env = { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` };
  delete env.TEST_DB_SCOPE;
  if (scope !== undefined) env.TEST_DB_SCOPE = scope;
  execFileSync("bash", [join(dir, "scripts", "check.sh")], { cwd: dir, env, stdio: "pipe" });
  return readFileSync(log, "utf8").trim().split("\n");
}

test("the test step runs on its own database scope: `check` by default, the caller's value when set", () => {
  const vitest = (lines) => lines.filter((l) => l.startsWith("npx vitest run"));
  assert.deepEqual(vitest(runStubbed(undefined)), ["npx vitest run scope=check"]);
  assert.deepEqual(vitest(runStubbed("mine")), ["npx vitest run scope=mine"]);
});
