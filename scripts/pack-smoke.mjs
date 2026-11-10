// Installs the three packages from `npm pack` tarballs into a scratch project outside the repository and runs the
// headless quick start against them, so what ships is what is tested. Needs the npm registry (for the packages' own
// dependencies) and Postgres (`docker compose up -d`). Not a gate step.
//   node scripts/pack-smoke.mjs [--keep]
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "@neondatabase/serverless";
import { baseDatabase, recreateDisposable } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["@jadd0/understudy-engine", "@jadd0/understudy-providers", "@jadd0/understudy-persona"];
/** The packages' peers, installed at the versions the repository's lockfile resolved. */
const PEERS = ["drizzle-orm", "@neondatabase/serverless", "ws"];

const keep = process.argv.includes("--keep");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.error) throw r.error;
  if (!opts.allowFailure && r.status !== 0) {
    process.stderr.write(`${r.stdout ?? ""}${r.stderr ?? ""}`);
    throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
  }
  return r;
}

function lockedVersion(name) {
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const version = lock.packages?.[`node_modules/${name}`]?.version;
  if (!version) throw new Error(`${name} is not in package-lock.json`);
  return version;
}

const inside = (child, parent) => !path.relative(parent, child).startsWith("..");

console.log("pack-smoke: building the packages");
run("npm", ["run", "--silent", "build:packages"], { cwd: root, stdio: "inherit" });

const scratch = mkdtempSync(path.join(os.tmpdir(), "understudy-pack-smoke-"));
if (inside(scratch, root)) throw new Error(`scratch directory ${scratch} is inside the repository`);
console.log(`pack-smoke: scratch directory ${scratch}`);

try {
  const tarballs = path.join(scratch, "tarballs");
  mkdirSync(tarballs);
  const packed = run("npm", ["pack", "--json", "--pack-destination", tarballs, ...PACKAGES.flatMap((p) => ["-w", p])], { cwd: root });
  const files = JSON.parse(packed.stdout).map((entry) => path.join(tarballs, entry.filename));
  if (files.length !== PACKAGES.length) throw new Error(`expected ${PACKAGES.length} tarballs, got ${files.length}`);

  const project = path.join(scratch, "project");
  mkdirSync(project);
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ private: true, type: "module" }));
  console.log("pack-smoke: installing the tarballs");
  run("npm", ["install", "--no-audit", "--no-fund", "--prefer-offline", ...files, ...PEERS.map((p) => `${p}@${lockedVersion(p)}`)], { cwd: project, stdio: "inherit" });

  // A fresh database of its own, next to the base one, so the quick start migrates from nothing.
  const base = baseDatabase();
  const name = `${base.name}_test_pack_smoke`;
  const admin = new Pool({ connectionString: base.url.toString() });
  try {
    await recreateDisposable(admin, name);
  } finally {
    await admin.end();
  }
  const url = new URL(base.url);
  url.pathname = `/${name}`;

  copyFileSync(path.join(root, "scripts/pack-smoke/quickstart.mjs"), path.join(project, "quickstart.mjs"));
  copyFileSync(path.join(root, "scripts/pack-smoke/config.json"), path.join(project, "config.json"));
  console.log(`pack-smoke: quick start against ${name}`);
  const quick = run("node", ["quickstart.mjs"], { cwd: project, env: { ...process.env, DATABASE_URL: url.toString() } });
  process.stdout.write(quick.stdout);
  if (!/^reply: .+/m.test(quick.stdout)) throw new Error("the quick start printed no reply");

  // The workspace-only entries are not part of the package.
  for (const entry of ["testing", "internal"]) {
    const probe = run("node", ["--input-type=module", "-e", `import("@jadd0/understudy-engine/${entry}").then(() => process.exit(3), (e) => { console.log(e.code); process.exit(e.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ? 0 : 4); })`], { cwd: project, allowFailure: true });
    if (probe.status !== 0) throw new Error(`@jadd0/understudy-engine/${entry} did not refuse: ${probe.stdout}${probe.stderr}`);
    console.log(`@jadd0/understudy-engine/${entry}: ${probe.stdout.trim()}`);
  }

  run("npx", ["--no-install", "understudy-persona", "--help"], { cwd: project, stdio: "ignore" });
  console.log("understudy-persona --help: exit 0");

  // The declarations compile for a consumer on strict NodeNext.
  writeFileSync(
    path.join(project, "check.ts"),
    [
      'import { createUnderstudy, type Understudy, type UnderstudyOptions } from "@jadd0/understudy-engine";',
      'import { FtsRetriever, noopEvents } from "@jadd0/understudy-providers";',
      'import { build } from "@jadd0/understudy-persona";',
      "declare const options: UnderstudyOptions;",
      "export const understudy: Understudy = createUnderstudy(options);",
      "export const parts = [FtsRetriever, noopEvents, build];",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(project, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, module: "nodenext", moduleResolution: "nodenext", noEmit: true, skipLibCheck: true, types: [] }, include: ["check.ts"] }),
  );
  run("node", [path.join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], { cwd: project });
  console.log("types ok");
} finally {
  if (keep) console.log(`pack-smoke: kept ${scratch}`);
  else rmSync(scratch, { recursive: true, force: true });
}
