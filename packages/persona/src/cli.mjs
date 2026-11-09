#!/usr/bin/env node
// understudy-persona <subcommand> [flags]
//
// Each subcommand runs the stage script of the same name with the flags passed through untouched,
// so its flags, defaults, exit code and output are exactly the script's own.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { STEPS } from "./build.mjs";

/** Subcommand -> script file in this directory. */
export const COMMANDS = {
  build: "build.mjs",
  synth: "synth.mjs",
  scrape: "scrape/scrape.mjs",
  eval: "eval-persona.mjs",
  "leak-check": "leak-check.mjs",
};

/** The individual pipeline stages `build` runs in order, plus the card-example helper. */
export const STAGES = {
  normalise: "normalise.mjs",
  split: "split.mjs",
  style: "style.mjs",
  chunks: "chunks.mjs",
  "draft-card": "draft-card.mjs",
  "rapid-eval": "rapid-eval.mjs",
  queries: "queries.mjs",
  "add-examples": "add-examples.mjs",
};

export const USAGE = `Usage: understudy-persona <subcommand> [flags]

Subcommands:
  build        run the whole pipeline (${STEPS.join(", ")})
  synth        generate a synthetic creator's raw records
  scrape       collect your own Instagram posts and replies (needs consent: see scrape --help)
  eval         persona judge and blind test
  leak-check   fail when a raw caption or reply appears in a git-tracked file

Single stages (the steps of build): ${Object.keys(STAGES).join(", ")}

Run a subcommand with its own flags; understudy-persona build --help lists the steps.`;

export function buildHelp() {
  return `Usage: understudy-persona build --creator <handle> --card-model <id> --gen-model <id> --jev-model <id> [flags]

Steps, in order (a step is skipped when its output exists):
${STEPS.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}

Flags:
  --seed <s>            split seed (default understudy-2026)
  --data <dir>          data directory (default data/persona)
  --card-version <n>    card version to draft (default 1)
  --query-model <id>    model for the retrieval queries (default: the card model)
  --label <name>        chunk label
  --budget <tokens>     token cap (default 2000000)
  --force <step>[,<step>]|all   re-run the named steps`;
}

/** Runs the CLI; returns the exit code. */
export function main(argv, { out = console.log, err = console.error } = {}) {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
    (sub === undefined ? err : out)(USAGE);
    return sub === undefined ? 2 : 0;
  }
  const file = COMMANDS[sub] ?? STAGES[sub];
  if (file === undefined) {
    err(`understudy-persona: unknown subcommand "${sub}"\n\n${USAGE}`);
    return 2;
  }
  if (sub === "build" && (rest.includes("--help") || rest.includes("-h"))) {
    out(buildHelp());
    return 0;
  }
  const run = spawnSync(process.execPath, [fileURLToPath(new URL(file, import.meta.url)), ...rest], { stdio: "inherit" });
  if (run.error) {
    err(`understudy-persona: could not start ${sub}`);
    return 1;
  }
  return run.status ?? 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
