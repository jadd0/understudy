#!/usr/bin/env node
// `npx understudy init ...`: onboards a creator from her own Instagram. The work is in
// persona/init.ts, which is TypeScript, so this launcher resolves the paths the caller typed
// against the caller's directory and runs that file with tsx from the repository root.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const INIT = "examples/app/scripts/persona/init.ts";
const ENV_FILE = "examples/app/.env.local";
// Flags whose value is a path.
const PATH_FLAGS = new Set(["--instagram-export", "--out", "--publish"]);

export const USAGE = `Usage: understudy init <flags>

  understudy init (--instagram-export <zip|folder> | --scrape-own) --email <address> --card-model <id> [flags]
  understudy init --publish <dir>
  understudy init --help`;

/** The arguments with each path flag's value made absolute against `cwd`. */
export function resolveArgs(args, cwd) {
  return args.map((arg, i) => (i > 0 && PATH_FLAGS.has(args[i - 1]) ? path.resolve(cwd, arg) : arg));
}

/** Runs the launcher; returns the exit code. */
export function main(argv, { cwd = process.cwd(), spawn = spawnSync, err = console.error } = {}) {
  const [command, ...rest] = argv;
  if (command !== "init") {
    err(`understudy: ${command === undefined ? "no command given" : `unknown command ${JSON.stringify(command)}`}\n\n${USAGE}`);
    return 2;
  }
  const tsx = createRequire(import.meta.url).resolve("tsx/cli");
  const run = spawn(process.execPath, [tsx, `--env-file-if-exists=${ENV_FILE}`, INIT, ...resolveArgs(rest, cwd)], { cwd: REPO_ROOT, stdio: "inherit" });
  if (run.error) {
    err("understudy: could not start the init script");
    return 1;
  }
  return run.status ?? 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
