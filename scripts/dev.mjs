// `npm run dev`: builds the packages once, then keeps `tsc -w` running on the engine and the providers next to
// `next dev`, so an engine edit lands in `dist` while the app is running. `npm run watch:packages` is the watchers alone.
//   node scripts/dev.mjs [watch | <next dev arguments>]
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { supervise } from "./supervise.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsc = path.join(root, "node_modules/typescript/bin/tsc");
const next = path.join(root, "node_modules/next/dist/bin/next");

/** One `tsc -w` per package, the engine first: the providers' declarations read the engine's built ones. */
export const watchSpecs = ["engine", "providers"].map((dir) => ({
  name: `tsc ${dir}`,
  cmd: process.execPath,
  args: [tsc, "-w", "--preserveWatchOutput", "-p", path.join(root, "packages", dir, "tsconfig.build.json")],
}));

export const nextSpec = (args) => ({ name: "next dev", cmd: process.execPath, args: [next, "dev", ...args], cwd: path.join(root, "examples/app") });

async function main() {
  const [first, ...rest] = process.argv.slice(2);
  const watchOnly = first === "watch";
  const build = spawnSync("npm", ["run", "--silent", "build:packages"], { cwd: root, stdio: "inherit" });
  if (build.status !== 0) process.exit(build.status ?? 1);
  const specs = watchOnly ? watchSpecs : [...watchSpecs, nextSpec(first === undefined ? [] : [first, ...rest])];
  process.exit(await supervise(specs));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
