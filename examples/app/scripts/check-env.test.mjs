import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkEnv, PRODUCTION_REQUIRED } from "./check-env.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-env.mjs");
const SECRET = "zzz-secret-marker-value";
const good = {
  DATABASE_URL: `postgresql://u:${SECRET}@db.example.test/app`,
  AUTH_SECRET: SECRET,
  AUTH_URL: "https://app.example.test",
  RESEND_API_KEY: `re_${SECRET}`,
  EMAIL_FROM: "Juno <hello@example.test>",
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: "site",
  TURNSTILE_SECRET_KEY: SECRET,
  CLAUDE_SECRET_KEY: SECRET,
  TYPESAFE_SECRET_KEY: SECRET,
  VOYAGE_API_KEY: SECRET,
  STRIPE_SECRET_KEY: `sk_test_${SECRET}`,
  STRIPE_WEBHOOK_SECRET: `whsec_${SECRET}`,
  PUSHER_APP_ID: "1",
  PUSHER_KEY: "k",
  PUSHER_SECRET: SECRET,
  PUSHER_CLUSTER: "eu",
  NEXT_PUBLIC_PUSHER_KEY: "k",
  NEXT_PUBLIC_PUSHER_CLUSTER: "eu",
  CRON_SECRET: SECRET,
};
const keys = (problems) => problems.map((p) => p.key).sort();

test("a complete env passes, including in production mode", async () => {
  assert.deepEqual(await checkEnv(good), []);
  assert.deepEqual(await checkEnv(good, { production: true }), []);
});

test("a missing required var is reported by name", async () => {
  const { AUTH_SECRET: _a, DATABASE_URL: _d, ...rest } = good;
  assert.deepEqual(keys(await checkEnv(rest)), ["AUTH_SECRET", "DATABASE_URL"]);
});

test("an empty required var counts as missing", async () => {
  assert.deepEqual(keys(await checkEnv({ ...good, RESEND_API_KEY: "" })), ["RESEND_API_KEY"]);
});

test("a malformed AUTH_URL is reported", async () => {
  for (const bad of ["not a url", "app.example.test", "https://app.example.test/"]) {
    assert.deepEqual(keys(await checkEnv({ ...good, AUTH_URL: bad })), ["AUTH_URL"], bad);
  }
});

test("other malformed shapes are reported", async () => {
  const bad = { ...good, STRIPE_WEBHOOK_SECRET: "nope", DATABASE_URL: "mysql://x", EMAIL_FROM: "no-at-sign" };
  assert.deepEqual(keys(await checkEnv(bad)), ["DATABASE_URL", "EMAIL_FROM", "STRIPE_WEBHOOK_SECRET"]);
});

test("production mode requires every deploy-time key and a matching browser copy", async () => {
  assert.ok(PRODUCTION_REQUIRED.length > 0);
  const { CRON_SECRET: _c, STRIPE_SECRET_KEY: _s, ...rest } = good;
  assert.deepEqual(keys(await checkEnv(rest)), []);
  assert.deepEqual(keys(await checkEnv(rest, { production: true })), ["CRON_SECRET", "STRIPE_SECRET_KEY"]);
  assert.deepEqual(keys(await checkEnv({ ...good, NEXT_PUBLIC_PUSHER_CLUSTER: "us2" })), ["NEXT_PUBLIC_PUSHER_CLUSTER"]);
  assert.deepEqual(keys(await checkEnv({ ...good, AUTH_URL: "http://app.example.test" }, { production: true })), ["AUTH_URL"]);
  assert.deepEqual(keys(await checkEnv({ ...good, STRIPE_SECRET_KEY: "sk_live_x" }, { production: true })), ["STRIPE_SECRET_KEY"]);
});

test("the CLI exits non-zero and never prints a value", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-env-"));
  const file = join(dir, "env");
  const lines = Object.entries({ ...good, AUTH_URL: "bad url", STRIPE_WEBHOOK_SECRET: SECRET }).filter(([k]) => k !== "AUTH_SECRET");
  writeFileSync(file, lines.map(([k, v]) => `${k}=${v}`).join("\n"));
  const run = spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf8" });
  assert.equal(run.status, 1);
  const out = run.stdout + run.stderr;
  assert.match(out, /AUTH_SECRET/);
  assert.match(out, /AUTH_URL/);
  assert.match(out, /STRIPE_WEBHOOK_SECRET/);
  assert.ok(!out.includes(SECRET), "no value appears in the output");
  assert.ok(!out.includes("bad url"), "no value appears in the output");
  const ok = writeFileSync(file, Object.entries(good).map(([k, v]) => `${k}=${v}`).join("\n"));
  assert.equal(ok, undefined);
  assert.equal(spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf8" }).status, 0);
});
