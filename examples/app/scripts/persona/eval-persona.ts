// The persona judge and blind test, generating through the engine's own prompt path:
//   npm run eval:persona -- --card-version 2 --gen-model <id> --judge-model <id> [--limit n] [--seed s] [--budget tokens]
// Each test pair's reply is built by the engine's prompt builder (card, lines retrieved from her train replies and
// captions, this reply's style draw at her measured rates), written by the generator, then cleaned at its edges by the
// engine's check. Results are recorded in docs/quality/evals/persona.json and docs/quality/EVALS.md like any other run.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildPrompt, drawFailures, drawStyle, enforceDraw, parseRates, qualityNote } from "@understudy/engine";
// The persona package is plain .mjs and takes no dependency on the engine, so the engine path is wired here.
// @ts-expect-error no declarations for the package's internals
import { evalPersona, recordResult, retrieveChunks, trainChunks } from "../../../../packages/persona/src/eval-persona.mjs";
// @ts-expect-error plain .mjs
import { createClaude } from "../../../../packages/persona/src/lib/claude.mjs";
// @ts-expect-error plain .mjs
import { parseArgs, seededRng, TokenBudget } from "../../../../packages/persona/src/lib/io.mjs";

type Pair = { id: string; replying_to: string };

/** A drafter that builds each prompt with the engine, drawing at `rates` (the stored `markers`), and cleans the reply with its check. */
export function engineDrafter({ rates, chunks, seed }: { rates: unknown; chunks: { id: string; text: string }[]; seed: string }) {
  const parsed = parseRates(rates);
  const drafter = async ({ pair, card }: { pair: Pair; card: string }) => {
    const draw = parsed ? drawStyle(parsed, pair.replying_to, seededRng(`${seed}:draw:${pair.id}`) as () => number) : null;
    const built = buildPrompt({
      cardBody: card,
      neverList: [],
      chunks: retrieveChunks(chunks, pair.replying_to),
      profile: { interests: [], dislikes: [] },
      route: { name: "reply", hardship: false, alert: false },
      offer: null,
      history: [{ id: pair.id, sender: "fan", body: pair.replying_to, createdAt: new Date(0) }],
      thread: "unknown",
      sessionGapMs: null,
      historyRounds: 10,
      gapMarkerMinutes: 30,
      styleDraw: draw && parsed ? { draw, pet: parsed.pet } : undefined,
    });
    const prompt = built.messages.map((m) => m.content).join("\n\n");
    const finish = (text: string) => (draw ? enforceDraw(text, draw) : text);
    return {
      system: `${built.system.cached}\n\n${built.system.turn}`,
      prompt,
      draw,
      finish,
      // The engine's second draft: a reply over the draw's length, or naming the pet it kept out, is asked for again once with the reason.
      retry: (finished: string) => {
        const failures = drawFailures(finished, draw, parsed);
        if (failures.length === 0) return null;
        return { system: `${built.system.cached}\n\n${built.system.turn}${qualityNote(failures, { targetChars: draw?.targetChars, pet: parsed?.pet })}`, prompt };
      },
    };
  };
  return Object.assign(drafter, {
    label: parsed ? "engine prompt, retrieval over train chunks, style draw, one retry on length or pet" : "engine prompt, retrieval over train chunks, no style draw",
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2)) as Record<string, string | undefined>;
  for (const flag of ["gen-model", "judge-model"]) if (typeof args[flag] !== "string") throw new Error(`--${flag} <id> is required`);
  const data = args.data ?? "data/persona";
  const bankDir = join(data, "bank");
  const seed = args.seed ?? "understudy-2026";
  const { readFileSync, existsSync } = await import("node:fs");
  const styleFile = join(bankDir, "style.json");
  const markers = existsSync(styleFile) ? (JSON.parse(readFileSync(styleFile, "utf8")) as { markers?: unknown }).markers ?? null : null;
  const limit = args.limit ? Number(args.limit) : null;
  const result = await evalPersona({
    bankDir,
    cardDir: join(data, "card"),
    cacheDir: join(data, "eval", "cache"),
    version: Number(args["card-version"] ?? 2),
    claude: createClaude(),
    genModel: args["gen-model"],
    judgeModel: args["judge-model"],
    seed,
    budget: new TokenBudget(Number(args.budget ?? 2_000_000)),
    limit,
    drafter: engineDrafter({ rates: markers, chunks: trainChunks(bankDir), seed }),
  });
  if (limit) console.log(`--limit ${limit}: nothing written`);
  else recordResult({ result, personaPath: "docs/quality/evals/persona.json", evalsPath: "docs/quality/EVALS.md" });
  console.log(JSON.stringify({ tokens: result.tokens_this_run, aggregate: result.aggregate }, null, 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
      process.exit(1);
    },
  );
}
