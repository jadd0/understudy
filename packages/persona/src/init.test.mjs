import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SECTIONS } from "./draft-card.mjs";
import { exportToRaw } from "./export/instagram-export.mjs";
import { draftPersona } from "./init.mjs";
import { readJson, readJsonl } from "./lib/io.mjs";
import { fakeCardClaude } from "./testing.mjs";

const FIXTURES = new URL("../fixtures/", import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), "init-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const headings = (card) => [...card.matchAll(/^## (.+)$/gm)].map((m) => m[1]);

test("an export drafts a seven-section card in lines mode, and no chunk comes from a comment", async () => {
  const dir = join(scratch, "export");
  exportToRaw({ input: `${FIXTURES}instagram-export`, rawRoot: join(dir, "raw"), now: () => new Date("2026-03-01T09:00:00Z") });
  const calls = [];
  const result = await draftPersona({ dir, handle: "wren.fixture", claude: fakeCardClaude({ calls }), cardModel: "card-model" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "card-model");
  assert.match(calls[0].prompt, /=== HER LINES/);
  assert.equal(result.pairs, 0);
  assert.equal(result.chunks, 5);
  assert.equal(result.exampleIds, 4);

  const card = readFileSync(join(dir, "card", "v1.md"), "utf8");
  assert.deepEqual(headings(card), SECTIONS);
  assert.match(card, /\*\*Wren Fixture:\*\* that means a lot, thank you/);
  assert.deepEqual(readJson(join(dir, "card", "v1.meta.json")).input.example_mode, "lines");

  const chunks = readJsonl(join(dir, "bank", "chunks.jsonl"));
  assert.ok(chunks.length > 0);
  assert.ok(chunks.every((chunk) => chunk.source === "caption" && chunk.source_url === null));
  assert.ok(!chunks.some((chunk) => /that means a lot|same time next week/.test(chunk.text)));
  assert.ok(!readdirSync(join(dir, "bank")).includes("eval"));
});

test("the committed raw fixture drafts too", async () => {
  const dir = join(scratch, "alice");
  cpSync(`${FIXTURES}raw`, join(dir, "raw"), { recursive: true });
  const result = await draftPersona({ dir, handle: "alice", claude: fakeCardClaude(), cardModel: "m" });
  assert.deepEqual(headings(readFileSync(join(dir, "card", "v1.md"), "utf8")), SECTIONS);
  assert.ok(result.chunks > 0);
});
