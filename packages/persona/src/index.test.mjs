import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as api from "./index.mjs";

const NAMES = [
  "synth", "normalise", "writeSplits", "writeStyle", "writeChunks", "draftCard", "rapidEval", "makeQueries",
  "build", "scrape", "evalPersona", "leakCheck", "createClaude", "createJev", "TokenBudget", "STEPS",
  "readInstagramExport", "exportToRaw", "draftPersona", "resolveOwnHandle", "createClient", "SECTIONS", "ZipError", "NotOwnAccount",
  "MIN_PAIRS", "HANDLE", "SYNTHETIC_HANDLES",
];

test("the public entry exports every documented name", () => {
  assert.deepEqual(Object.keys(api).sort(), [...NAMES].sort());
  for (const name of NAMES) assert.ok(api[name] !== undefined, name);
});

test("index.d.ts declares every exported name", () => {
  const dts = readFileSync(new URL("./index.d.ts", import.meta.url), "utf8");
  for (const name of NAMES) assert.match(dts, new RegExp(`export (declare )?(function|class|const) ${name}\\b`), name);
});
