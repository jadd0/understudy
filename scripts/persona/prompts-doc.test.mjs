// Docs quote every Claude and Jev prompt verbatim. In any markdown file under docs/, each fenced
// block that follows a `<!-- prompt-src: <path> -->` marker must appear, character for character, in
// that source file, so a doc fails the gate the moment a prompt changes without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DOC = "docs/PERSONA-PROMPTS.md";

export function promptBlocks(markdown) {
  return [...markdown.matchAll(/<!-- prompt-src: (\S+) -->\n```text\n([\s\S]*?)\n```/g)].map((m) => ({ src: m[1], text: m[2] }));
}

test("promptBlocks reads marker and body", () => {
  const md = "x\n<!-- prompt-src: a.mjs -->\n```text\nhello ${name}\nline 2\n```\n";
  assert.deepEqual(promptBlocks(md), [{ src: "a.mjs", text: "hello ${name}\nline 2" }]);
});

function markdownFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? markdownFiles(join(dir, e.name)) : e.name.endsWith(".md") ? [join(dir, e.name)] : [],
  );
}

test("PERSONA-PROMPTS.md quotes all eight persona prompts", () => {
  const blocks = promptBlocks(readFileSync(DOC, "utf8"));
  assert.ok(blocks.length >= 8, `expected at least 8 prompt blocks, found ${blocks.length}`);
});

test("every prompt block under docs/ matches its source verbatim", () => {
  for (const doc of markdownFiles("docs")) {
    for (const { src, text } of promptBlocks(readFileSync(doc, "utf8"))) {
      assert.ok(readFileSync(src, "utf8").includes(text), `${doc}: a block no longer matches ${src}:\n${text.slice(0, 120)}…`);
    }
  }
});
