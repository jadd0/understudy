// Static checks on the container image definition; no docker needed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const dockerfile = read("Dockerfile");
const lines = dockerfile.split("\n").map((l) => l.trim());

test("every stage starts from an official node image", () => {
  const from = lines.filter((l) => /^FROM\s/i.test(l));
  assert.ok(from.length >= 2, "multi-stage");
  for (const l of from) assert.match(l, /^FROM node:22-bookworm-slim(\s+AS\s+\w+)?$/i);
});

test("no env file is copied and no secret is set in the image", () => {
  const instructions = lines.filter((l) => l && !l.startsWith("#"));
  assert.ok(!instructions.some((l) => /^(COPY|ADD)\b.*\.env/i.test(l)), "copies an env file");
  const envs = instructions.filter((l) => /^ENV\b/i.test(l));
  assert.ok(envs.length > 0);
  for (const l of envs) assert.doesNotMatch(l, /KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL/i, l);
  assert.ok(!instructions.some((l) => /^ARG\b.*(KEY|SECRET|TOKEN|PASSWORD)/i.test(l)));
});

test("it exposes the server port and runs the server workspace as a non-root user", () => {
  assert.ok(lines.includes("EXPOSE 8787"));
  assert.ok(lines.some((l) => /^CMD\b.*@understudy\/example-server/.test(l)));
  assert.ok(lines.includes("USER node"));
  assert.ok(lines.includes("ENV HOST=0.0.0.0"));
});

test("the server has a start script", () => {
  assert.ok(JSON.parse(read("examples/server/package.json")).scripts.start);
});

test(".dockerignore keeps secrets and process files out of the build context", () => {
  const ignored = read(".dockerignore").split("\n").map((l) => l.trim());
  for (const entry of [".env*", ".product", "node_modules", ".claude"]) assert.ok(ignored.includes(entry), entry);
});
