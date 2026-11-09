import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SRC = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8"));

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(mjs|ts)$/.test(name) && !name.endsWith("package.test.mjs") ? [path] : [];
  });
}

test("the package has zero dependencies", () => {
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    assert.deepEqual(Object.keys(PKG[key] ?? {}), [], key);
  }
});

test("package sources import only node built-ins and their own files", () => {
  const files = sources(SRC);
  assert.ok(files.length > 20, "found the package sources");
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const specs = [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of specs) {
      assert.ok(spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../"), `${file}: ${spec}`);
      assert.ok(!spec.startsWith("@/"), `${file}: ${spec}`);
      if (spec.startsWith("../")) assert.ok(join(dirname(file), spec).startsWith(SRC), `${file} reaches outside src: ${spec}`);
    }
  }
});
