// Runs the whole pipeline: normalise -> split -> style -> chunks -> draft-card -> rapid-eval -> queries.
//
//   understudy-persona build --creator junovale --card-model <id> --gen-model <id> --jev-model <id>
//        [--seed understudy-2026] [--data data/persona] [--card-version 1] [--query-model <id>]
//        [--label juno] [--budget 2000000] [--force <step>[,<step>]|all]
//
// A step is skipped when its output exists. --force re-runs only the named step; the steps
// after it are skipped while their outputs exist, so force them too when the input changed. Models are flags only; they are recorded in
// each *.meta.json. The token budget (default 2M) stops the run when exceeded.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isMain, loadEnvFile, parseArgs, TokenBudget } from "./lib/io.mjs";
import { createClaude } from "./lib/claude.mjs";
import { createJev } from "./lib/jev.mjs";
import { normalise } from "./normalise.mjs";
import { writeSplits } from "./split.mjs";
import { writeStyle } from "./style.mjs";
import { writeChunks } from "./chunks.mjs";
import { draftCard } from "./draft-card.mjs";
import { rapidEval } from "./rapid-eval.mjs";
import { makeQueries } from "./queries.mjs";

export const STEPS = ["normalise", "split", "style", "chunks", "draft-card", "rapid-eval", "queries"];

function need(args, flag) {
  if (typeof args[flag] !== "string") throw new Error(`--${flag} <value> is required`);
  return args[flag];
}

export async function build(args) {
  const creator = need(args, "creator");
  const seed = args.seed ?? "understudy-2026";
  const data = args.data ?? "data/persona";
  const version = Number(args["card-version"] ?? 1);
  const bankDir = join(data, "bank");
  const cardDir = join(data, "card");
  const evalDir = join(data, "eval");
  const budget = new TokenBudget(Number(args.budget ?? 2_000_000));

  const forced = args.force === "all" ? STEPS : String(args.force ?? "").split(",").filter(Boolean);
  for (const step of forced) if (!STEPS.includes(step)) throw new Error(`unknown step to force: ${step}`);

  const outputs = {
    normalise: join(bankDir, "replies.jsonl"),
    split: join(bankDir, "splits.json"),
    style: join(bankDir, "style.json"),
    chunks: join(bankDir, "chunks.jsonl"),
    "draft-card": join(cardDir, `v${version}.md`),
    "rapid-eval": join(cardDir, `v${version}.eval.json`),
    queries: join(evalDir, "retrieval-queries.jsonl"),
  };

  const runners = {
    normalise: () => normalise({ rawDir: args.raw ?? join(data, "raw"), outDir: bankDir, creator }).counts,
    split: () => writeSplits({ bankDir, seed }).counts,
    style: () => {
      const s = writeStyle({ bankDir });
      return { captions: s.captions.n, replies: s.replies.n };
    },
    chunks: () => ({ chunks: writeChunks({ bankDir, label: args.label }).length }),
    "draft-card": async () => {
      const out = await draftCard({ bankDir, cardDir, claude: createClaude(), model: need(args, "card-model"), version, budget, seed });
      return { examples: out.exampleIds.length, warnings: out.warnings };
    },
    "rapid-eval": async () => {
      const r = await rapidEval({ bankDir, cardDir, version, claude: createClaude(), jev: createJev(), genModel: need(args, "gen-model"), jevModel: need(args, "jev-model"), seed, budget });
      return r.aggregate;
    },
    queries: async () => {
      const rows = await makeQueries({ bankDir, evalDir, claude: createClaude(), model: args["query-model"] ?? need(args, "card-model"), seed, budget });
      return { queries: rows.length };
    },
  };

  for (const step of STEPS) {
    if (!forced.includes(step) && existsSync(outputs[step])) {
      console.log(`skip   ${step} (output exists)`);
      continue;
    }
    console.log(`run    ${step}`);
    console.log(`       ${JSON.stringify(await runners[step]())}`);
  }
  console.log(`tokens ${JSON.stringify({ total: budget.used, claude_input: budget.claudeInput, claude_output: budget.claudeOutput, jev_input: budget.jevInput, calls: budget.calls, cap: budget.cap })}`);
  return budget;
}

if (isMain(import.meta.url)) {
  loadEnvFile(".env.local");
  await build(parseArgs(process.argv.slice(2)));
}
