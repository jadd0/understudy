import { test } from "node:test";
import assert from "node:assert/strict";
import { brokenLinks } from "./check-links.mjs";

const here = new Set(["/r/docs/a.md", "/r/docs/img/x.png", "/r/docs"]);
const exists = (p) => here.has(p);
const check = (md) => brokenLinks(md, "/r/docs", exists);

test("a good link and a good image pass", () => {
  assert.deepEqual(check("[a](a.md) ![x](img/x.png) [dir](.)"), []);
});

test("a broken link and a broken image fail with their line", () => {
  assert.deepEqual(check("ok\n[a](missing.md)\n![x](img/none.png)"), [
    { line: 2, target: "missing.md" },
    { line: 3, target: "img/none.png" },
  ]);
});

test("anchors, external URLs, mail and code fences are skipped", () => {
  assert.deepEqual(check("[a](#top) [b](https://x.test/y.md) [c](mailto:a@b.c)\n```\n[d](gone.md)\n```"), []);
});

test("an anchor on a file checks only the file", () => {
  assert.deepEqual(check("[a](a.md#sec) [b](gone.md#sec)"), [{ line: 1, target: "gone.md#sec" }]);
});

test("a reference definition is checked", () => {
  assert.deepEqual(check("[r]: gone.md"), [{ line: 1, target: "gone.md" }]);
});
