import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS, main } from "./cli.mjs";
import { STEPS } from "./build.mjs";

function run(argv) {
  const out = [];
  const err = [];
  const code = main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("unknown subcommand exits 2 with usage", () => {
  const r = run(["frobnicate"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown subcommand "frobnicate"/);
  assert.match(r.err, /Usage: understudy-persona <subcommand>/);
  assert.equal(r.out, "");
});

test("no subcommand exits 2 with usage", () => {
  const r = run([]);
  assert.equal(r.code, 2);
  assert.match(r.err, /Usage: understudy-persona/);
});

test("build --help lists the steps", () => {
  const r = run(["build", "--help"]);
  assert.equal(r.code, 0);
  assert.ok(STEPS.length > 0);
  for (const step of STEPS) assert.match(r.out, new RegExp(`\\b${step}\\b`), step);
});

test("the top-level usage names every documented subcommand", () => {
  const r = run(["--help"]);
  assert.equal(r.code, 0);
  assert.deepEqual(Object.keys(COMMANDS), ["build", "synth", "scrape", "eval", "leak-check"]);
  for (const name of Object.keys(COMMANDS)) assert.match(r.out, new RegExp(`^  ${name}\\b`, "m"), name);
});

test("a subcommand passes its exit code through (scrape --help exits 0 with the consent line)", () => {
  const r = run(["scrape", "--help"]);
  assert.equal(r.code, 0);
});
