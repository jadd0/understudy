// Shared plumbing for the persona scripts: jsonl and json files, a stable sort, a seeded PRNG,
// argument parsing and the token budget. Node built-ins only.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export function readJsonl(path) {
  const text = readFileSync(path, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

export function writeJsonl(path, rows) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export function fileExists(path) {
  return existsSync(path);
}

export function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** First 16 hex characters of the sha256 of a string: the id scheme for bank rows. */
export function sha16(text) {
  return sha256Hex(text).slice(0, 16);
}

/** Stable ascending sort by a string or number key; ties keep input order. Returns a new array. */
export function stableSort(items, keyFn) {
  return items
    .map((item, index) => ({ item, index, key: keyFn(item) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index))
    .map((entry) => entry.item);
}

/** mulberry32 seeded from the first 32 bits of the sha256 of the seed string. Returns () => [0, 1). */
export function seededRng(seed) {
  let state = parseInt(sha256Hex(String(seed)).slice(0, 8), 16) >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates over a copy, driven by the given rng. */
export function shuffled(items, rng) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** `--flag value` and bare `--flag` pairs into an object; repeated flags keep the last value. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[name] = true;
    else {
      out[name] = next;
      i++;
    }
  }
  return out;
}

/** True when the module is the entry point (`node file.mjs`), false when imported by a test. */
export function isMain(importMetaUrl) {
  return process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === importMetaUrl;
}

/** Loads KEY=VALUE pairs from a file into process.env without overriding values already set. */
export function loadEnvFile(path) {
  try {
    process.loadEnvFile(path);
  } catch {
    // A missing env file is fine: the adapters report the missing key themselves.
  }
}

export class BudgetExceeded extends Error {
  constructor(used, cap) {
    super(`token budget exceeded: ${used} > ${cap}`);
    this.name = "BudgetExceeded";
    this.used = used;
    this.cap = cap;
  }
}

/** Running token total across every model call of one build; throws once the cap is passed. */
export class TokenBudget {
  constructor(cap = 2_000_000) {
    this.cap = cap;
    this.used = 0;
    this.claudeInput = 0;
    this.claudeOutput = 0;
    this.jevInput = 0;
    this.calls = 0;
  }

  addClaude(usage) {
    this.claudeInput += usage.input_tokens;
    this.claudeOutput += usage.output_tokens;
    this.#add(usage.input_tokens + usage.output_tokens);
  }

  addJev(usage) {
    this.jevInput += usage.input_tokens;
    this.#add(usage.input_tokens + usage.output_tokens);
  }

  #add(tokens) {
    this.calls++;
    this.used += tokens;
    if (this.used > this.cap) throw new BudgetExceeded(this.used, this.cap);
  }
}
