// Checks an env file against the schema in lib/env and the extra shape rules below, and prints names only.
//   npm run check:env -- [file] [--production] [--safety-config=<file>]
// file defaults to the app's own .env.local (examples/app/.env.local). --production also requires every key the deployed app needs at runtime
// (the schema leaves provider keys optional so local work does not need them) and an https AUTH_URL.
// It also names any safety check switched off in the server config or the app seed (or --safety-config), as information only.
// It also prints what is on and, for each optional service that is off, what the app does without it, and one gateway
// line: the switches are config rows, so it reads them from the seed and the server config (a database row can differ).
// Exit 0 when nothing is wrong, 1 otherwise. A value is never printed, only the key name and the rule it broke.
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Keys the app cannot start without, in every mode. */
export const REQUIRED = ["DATABASE_URL", "AUTH_SECRET", "CLAUDE_SECRET_KEY"];

/** Optional in the schema but required once deployed. CRON_SECRET is read by the cron route, outside the schema. */
export const PRODUCTION_REQUIRED = [
  "AUTH_URL",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  "CLAUDE_SECRET_KEY",
  "TYPESAFE_SECRET_KEY",
  "VOYAGE_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "PUSHER_APP_ID",
  "PUSHER_KEY",
  "PUSHER_SECRET",
  "PUSHER_CLUSTER",
  "NEXT_PUBLIC_PUSHER_KEY",
  "NEXT_PUBLIC_PUSHER_CLUSTER",
  "CRON_SECRET",
];

function isUrl(value, protocols) {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** Shape rules for values that are present. Each returns the rule it broke, or null. */
const SHAPES = {
  DATABASE_URL: (v) => (/^postgres(ql)?:\/\/\S+$/.test(v) ? null : "must be a postgres:// connection string"),
  AUTH_URL: (v) => (isUrl(v, ["http:", "https:"]) && !v.endsWith("/") ? null : "must be an http(s) URL with no trailing slash"),
  EMAIL_FROM: (v) => (/^([^<>]+<)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(v) ? null : "must be an address or Name <address>"),
  RESEND_API_KEY: (v) => (v.startsWith("re_") ? null : "must start with re_"),
  STRIPE_SECRET_KEY: (v) => (/^(sk|rk)_(test|live)_/.test(v) ? null : "must start with sk_test_, sk_live_, rk_test_ or rk_live_"),
  STRIPE_WEBHOOK_SECRET: (v) => (v.startsWith("whsec_") ? null : "must start with whsec_"),
  SEED_CREATOR_EMAIL: (v) => (/^[^\s@]+@[^\s@]+$/.test(v) ? null : "must be an email address"),
  SEED_ADMIN_EMAILS: (v) => (v.split(",").every((e) => /^[^\s@]+@[^\s@]+$/.test(e.trim())) ? null : "must be comma-separated email addresses"),
  PUSHER_CLUSTER: (v) => (/^[a-z0-9-]+$/.test(v) ? null : "must be a cluster id such as eu"),
  NEXT_PUBLIC_PUSHER_CLUSTER: (v) => (/^[a-z0-9-]+$/.test(v) ? null : "must be a cluster id such as eu"),
};

/** Keys that must carry the same value as another key (the browser copy of a server key). */
const MIRRORS = [
  ["NEXT_PUBLIC_PUSHER_KEY", "PUSHER_KEY"],
  ["NEXT_PUBLIC_PUSHER_CLUSTER", "PUSHER_CLUSTER"],
];

let loads = 0;

/** Runs lib/env's own schema over `values` and returns the keys it rejects. */
async function schemaFailures(values) {
  const saved = process.env;
  process.env = { ...values };
  try {
    const { getEnv } = await import(`../lib/env/index.ts?load=${loads++}`);
    getEnv();
    return [];
  } catch (e) {
    const names = String(e.message).split(": ").slice(1).join(": ");
    return names ? names.split(", ") : ["(schema)"];
  } finally {
    process.env = saved;
  }
}

/** Returns { problems: [{ key, rule }] } for a parsed env. Pure over `values`; reads no file. */
export async function checkEnv(values, { production = false } = {}) {
  const problems = [];
  const failed = new Set(await schemaFailures(values));
  for (const key of failed) {
    problems.push({ key, rule: key in values ? "is empty: lib/env rejects an empty value, fill it or remove the line" : "is missing (required by lib/env)" });
  }
  if (production) {
    for (const key of PRODUCTION_REQUIRED) {
      if (!values[key] && !failed.has(key)) problems.push({ key, rule: "is missing (required in production)" });
    }
  }
  for (const [key, shape] of Object.entries(SHAPES)) {
    const value = values[key];
    if (!value) continue;
    const rule = shape(value);
    if (rule) problems.push({ key, rule });
  }
  for (const [browser, server] of MIRRORS) {
    if (values[browser] && values[server] && values[browser] !== values[server]) {
      problems.push({ key: browser, rule: `must equal ${server}` });
    }
  }
  if (production && values.AUTH_URL && isUrl(values.AUTH_URL, ["http:"])) {
    problems.push({ key: "AUTH_URL", rule: "must be https in production" });
  }
  if (production && values.STRIPE_SECRET_KEY?.startsWith("sk_live_")) {
    problems.push({ key: "STRIPE_SECRET_KEY", rule: "is a live key: use sk_test_ until the founder switches to live money" });
  }
  return problems;
}

/** Config files that carry the platform's `safety.<key>.enabled` rows, read as text (the app's seed is TypeScript). */
export const SAFETY_CONFIG_FILES = ["../../server/config.json", "../db/seed.ts"];

/** Names of the safety checks a config text switches off. Pure over `text`; a check is off only by an explicit `false`. */
export function disabledSafetyChecks(text) {
  return [...text.matchAll(/"safety\.([a-z_]+)\.enabled"\s*:\s*false\b/g)].map((m) => m[1]);
}

/** Reads each config file that exists and returns the disabled checks as `{ file, check }`. */
export function scanDisabledSafety(files) {
  const found = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const check of disabledSafetyChecks(text)) found.push({ file, check });
  }
  return found;
}

/** Which gateway switches a config text turns on, by explicit `true`: `generate`, `decide`. Pure over `text`. */
export function enabledGatewaySwitches(text) {
  return [...text.matchAll(/"gateway\.(generate|decide)\.enabled"\s*:\s*true\b/g)].map((m) => m[1]);
}

/** One line on the llm-gateway: off, on for which calls, or switched on with nothing to send to. Names only. */
export function gatewayLine(values, switches) {
  const on = [...new Set(switches)].sort((a, b) => (a === "generate" ? -1 : b === "generate" ? 1 : 0));
  const url = Boolean(values.GATEWAY_URL);
  if (on.length === 0) return `gateway: off${url ? " (GATEWAY_URL is set, both switches are false in the seed and server config)" : ""}`;
  if (!url) return `gateway: switched on for ${on.join(", ")} in the config but GATEWAY_URL is not set: calls go to Claude and Jev directly`;
  return `gateway: on for ${on.join(", ")}${values.GATEWAY_KEY ? "" : " (GATEWAY_KEY is not set: only creators with their own gateway.key_env have a key)"}`;
}

/** The status table: each required key ok / missing / malformed, then each optional service on or off with its fallback. Names only. */
export async function statusLines(values, problems, switches = []) {
  const { providerStatus } = await import(`../lib/env/index.ts?table=${loads++}`);
  const lines = ["required:"];
  for (const key of REQUIRED) {
    const bad = problems.find((p) => p.key === key);
    const state = !values[key] ? "missing" : bad ? "malformed" : "ok";
    lines.push(`  ${key.padEnd(34)} ${state}`);
  }
  lines.push("optional:");
  for (const s of providerStatus(values)) {
    lines.push(`  ${s.name.padEnd(34)} ${s.on ? "on" : `off - without it: ${s.fallback}`}`);
  }
  lines.push(`  ${gatewayLine(values, switches)}`);
  return lines;
}

async function main(argv) {
  const production = argv.includes("--production");
  const file = argv.find((a) => !a.startsWith("--")) ?? fileURLToPath(new URL("../.env.local", import.meta.url));
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    console.error(`check-env: cannot read ${file}`);
    return 1;
  }
  const values = parseEnv(text);
  const problems = await checkEnv(values, { production });
  const override = argv.find((a) => a.startsWith("--safety-config="))?.slice("--safety-config=".length);
  const safetyFiles = override ? [override] : SAFETY_CONFIG_FILES.map((p) => fileURLToPath(new URL(p, import.meta.url)));
  const switches = safetyFiles.flatMap((f) => {
    try {
      return enabledGatewaySwitches(readFileSync(f, "utf8"));
    } catch {
      return [];
    }
  });
  for (const line of await statusLines(values, problems, switches)) console.log(line);
  for (const { file, check } of scanDisabledSafety(safetyFiles)) console.log(`check-env: safety check ${check} is disabled in ${file}`);
  if (problems.length === 0) {
    console.log(`check-env: ${file} OK${production ? " (production)" : ""}`);
    return 0;
  }
  for (const { key, rule } of problems) console.error(`check-env: ${key} ${rule}`);
  console.error(`check-env: ${problems.length} problem(s) in ${file}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
