// Offline checks on what the three packages publish. Needs the engine and providers built (`npm run build:packages`).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
const json = (p) => JSON.parse(read(p));

const PACKAGES = [
  { dir: "engine", name: "@jadd0/understudy-engine" },
  { dir: "providers", name: "@jadd0/understudy-providers" },
  { dir: "persona", name: "@jadd0/understudy-persona" },
];

test("the engine README's quick start is the file the smoke test runs", () => {
  const readme = read("packages/engine/README.md");
  const marker = "<!-- quickstart: scripts/pack-smoke/quickstart.mjs -->";
  const at = readme.indexOf(marker);
  assert.ok(at >= 0, "the README names the quick start file");
  const fence = /^```js\n([\s\S]*?)\n```/m.exec(readme.slice(at + marker.length));
  assert.ok(fence, "a js fence follows the marker");
  assert.equal(fence[1].trim(), read("scripts/pack-smoke/quickstart.mjs").trim());
});

test("each package is publishable: version, licence, repository, files, README and a LICENSE equal to the root one", () => {
  for (const { dir, name } of PACKAGES) {
    const manifest = json(`packages/${dir}/package.json`);
    assert.equal(manifest.name, name);
    assert.equal("private" in manifest, false, `${name} is private`);
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.equal(manifest.license, "MIT");
    assert.equal(manifest.publishConfig?.access, "public");
    assert.equal(manifest.repository?.directory, `packages/${dir}`);
    assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, `${name} lists files`);
    // npm drops a bin entry written with a leading `./` when it publishes.
    for (const [bin, target] of Object.entries(manifest.bin ?? {})) assert.ok(!target.startsWith("./"), `${name} bin ${bin} -> ${target}`);
    assert.ok(read(`packages/${dir}/README.md`).length > 200, `${name} has a README`);
    assert.equal(read(`packages/${dir}/LICENSE`), read("LICENSE"), `${name} LICENSE differs from the root one`);
  }
});

test("published exports name only built files, and the engine exposes exactly its three entries", () => {
  const targets = (exp) => (typeof exp === "string" ? [exp] : Object.values(exp).flatMap(targets));
  for (const dir of ["engine", "providers"]) {
    const manifest = json(`packages/${dir}/package.json`);
    const entries = Object.entries(manifest.exports).filter(([key]) => key !== "./package.json");
    assert.ok(entries.length > 0);
    for (const [key, exp] of entries) {
      for (const target of targets(exp)) {
        assert.ok(target.startsWith("./dist/"), `${dir} ${key} -> ${target}`);
        assert.ok(existsSync(path.join(root, "packages", dir, target)), `${dir} ${key} -> ${target} is not built`);
      }
    }
  }
  assert.deepEqual(Object.keys(json("packages/engine/package.json").exports).sort(), [".", "./fakes", "./package.json", "./schema"]);
});

function packList(name) {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "-w", name], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout)[0].files.map((f) => f.path);
}

test("the tarballs carry the built files and neither source, tests nor the workspace-only entries", () => {
  const engine = packList("@jadd0/understudy-engine");
  for (const want of ["dist/index.js", "dist/index.d.ts", "dist/db/schema.js", "dist/fakes.js", "drizzle/meta/_journal.json"]) assert.ok(engine.includes(want), `engine lacks ${want}`);
  assert.ok(engine.length > 50);
  for (const bad of [/^src\//, /\.test\./, /^dist\/(internal|testing)\./, /^dist\/testing\/(?!fakes\/)/, /^\.env/, /^data\//]) assert.deepEqual(engine.filter((f) => bad.test(f)), [], String(bad));

  const providers = packList("@jadd0/understudy-providers");
  for (const want of ["dist/index.js", "dist/index.d.ts"]) assert.ok(providers.includes(want), `providers lacks ${want}`);
  for (const bad of [/^src\//, /\.test\./, /^\.env/]) assert.deepEqual(providers.filter((f) => bad.test(f)), [], String(bad));

  const persona = packList("@jadd0/understudy-persona");
  for (const want of ["src/index.mjs", "src/index.d.ts", "src/cli.mjs"]) assert.ok(persona.includes(want), `persona lacks ${want}`);
  assert.deepEqual(persona.filter((f) => /\.test\.mjs$/.test(f)), []);
});

test("the tsconfig paths agree with workspace-sources.json", () => {
  const sources = json("workspace-sources.json");
  assert.ok(Object.keys(sources).length >= 5);

  const rootPaths = json("tsconfig.json").compilerOptions.paths;
  for (const [name, file] of Object.entries(sources)) assert.deepEqual(rootPaths[name], [`./${file}`], `root tsconfig ${name}`);

  // The app resolves the packages to their built output (its bundler cannot map `./x.js` to `x.ts`); the one entry
  // that is never built, `testing`, is only type-checked there and stays on source.
  const appPaths = json("examples/app/tsconfig.json").compilerOptions.paths;
  for (const [name, file] of Object.entries(sources)) {
    const expected = name.endsWith("/testing") ? `../../${file}` : `../../${file.replace("/src/", "/dist/").replace(/\.ts$/, "")}`;
    assert.deepEqual(appPaths[name], [expected], `app tsconfig ${name}`);
  }
});

test("the consumer type check fails on a shipped declaration or on check.ts and tolerates only third-party ones", async () => {
  const { sortDiagnostics } = await import("./pack-smoke/diagnostics.mjs");
  const output = [
    "node_modules/drizzle-orm/sqlite-core/query-builders/select.d.ts(233,247): error TS2344: Type 'string' does not satisfy",
    "  Type 'string' is not assignable to type 'keyof this & string'.",
    "node_modules/@jadd0/understudy-engine/dist/index.d.ts(3,10): error TS2305: Module has no exported member",
    "check.ts(2,1): error TS2307: Cannot find module",
    "../elsewhere/node_modules/@jadd0/understudy-providers/dist/index.d.ts(1,1): error TS1005: ';' expected.",
    "",
  ].join("\n");
  const { own, other } = sortDiagnostics(output);
  assert.equal(other.length, 1);
  assert.match(other[0], /drizzle-orm/);
  assert.equal(own.length, 3);
  assert.deepEqual(sortDiagnostics("").own, []);
});

test("the providers build builds the engine first when its declarations are missing", () => {
  const { prebuild, build } = json("packages/providers/package.json").scripts;
  assert.match(prebuild, /engine\/dist\/index\.d\.ts/);
  assert.match(prebuild, /--prefix \.\.\/engine run build/);
  assert.match(build, /tsc -p tsconfig\.build\.json/);
});

test("pack-smoke packs without scripts, checks library declarations, ships no config copy and imports the gateway adapters", () => {
  const source = read("scripts/pack-smoke.mjs");
  assert.match(source, /"pack", "--json", "--ignore-scripts"/);
  assert.match(source, /skipLibCheck: false/);
  assert.doesNotMatch(source, /skipLibCheck: true/);
  assert.match(source, /examples\/server\/config\.json/);
  assert.equal(existsSync(path.join(root, "scripts/pack-smoke/config.json")), false);
  for (const name of ["GatewayGenerator", "GatewayDecider", "envKeyResolver", "FailoverGenerator"]) assert.match(source, new RegExp(`import \\{[^}]*\\b${name}\\b`), name);
});
