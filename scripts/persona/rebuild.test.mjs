import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalise, writeChunks, writeSplits, writeStyle } from "@understudy/persona";

const DATA = new URL("../../data/persona", import.meta.url).pathname;
const BANK = join(DATA, "bank");

test("normalise, split, style and chunks rebuilt through the package from data/persona/raw equal the committed bank byte for byte", () => {
  const out = mkdtempSync(join(tmpdir(), "persona-rebuild-"));
  normalise({ rawDir: join(DATA, "raw"), outDir: out, creator: "junovale" });
  writeSplits({ bankDir: out, seed: "understudy-2026" });
  writeStyle({ bankDir: out });
  writeChunks({ bankDir: out });

  const committed = readdirSync(BANK).sort();
  const rebuilt = readdirSync(out).sort();
  assert.ok(committed.length >= 7, "the committed bank has its files");
  assert.deepEqual(rebuilt, committed);
  for (const name of committed) {
    assert.equal(readFileSync(join(out, name), "utf8"), readFileSync(join(BANK, name), "utf8"), name);
  }
});
