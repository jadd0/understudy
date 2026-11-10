// Rehearses publishing the three packages: a clean tree, a build, the pack smoke test, then npm's own dry run.
// Nothing is published. A real publish is the maintainer's own command, printed at the end.
//   node scripts/release.mjs
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACES = ["@jadd0/understudy-engine", "@jadd0/understudy-providers", "@jadd0/understudy-persona"];
const SCOPE_ARGS = ["--access", "public", ...WORKSPACES.flatMap((name) => ["-w", name])];

/** The arguments of the one `npm` call this script makes to publish; `--dry-run` is part of them. */
export const PUBLISH_ARGS = ["publish", "--dry-run", ...SCOPE_ARGS];

const step = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: root, encoding: "utf8", stdio: "inherit", ...opts });

function main() {
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim();
  if (dirty) {
    console.error(`release: the working tree is not clean, commit or stash first:\n${dirty}`);
    process.exit(1);
  }

  for (const [cmd, args] of [
    ["npm", ["run", "--silent", "build:packages"]],
    ["node", ["scripts/pack-smoke.mjs"]],
  ]) {
    if (step(cmd, args).status !== 0) {
      console.error(`release: ${cmd} ${args.join(" ")} failed`);
      process.exit(1);
    }
  }

  const dry = step("npm", PUBLISH_ARGS, { stdio: ["inherit", "inherit", "pipe"] });
  process.stderr.write(dry.stderr ?? "");
  if (dry.status !== 0) {
    if (/ENEEDAUTH/.test(dry.stderr ?? "")) {
      console.error("release: npm login required for the dry run");
      process.exit(2);
    }
    console.error("release: npm publish --dry-run failed");
    process.exit(1);
  }

  if (/auto-corrected/.test(dry.stderr ?? "")) {
    console.error("release: npm changed a package.json while publishing; run `npm pkg fix` and commit the result");
    process.exit(1);
  }

  console.log("\nrelease: dry run only: nothing was published.");
  console.log("To publish for real, run these yourself:");
  console.log("  npm login");
  console.log(`  npm ${PUBLISH_ARGS.filter((a) => a !== "--dry-run").join(" ")}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
