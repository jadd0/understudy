// Adds founder-chosen example pairs to an existing card's Examples section, verbatim from the bank.
// The card text is still never typed by hand: each added pair is rendered by `renderExamples` from a
// TRAIN reply id, exactly like the model-picked examples, and the ids and the reason are recorded in
// v<N>.meta.json (`extra_example_ids`, `extra_examples_reason`). Validation and test ids are refused.
//
//   node scripts/persona/add-examples.mjs --card-version 2 --ids id1,id2 --reason "founder: more cheeky ones"
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { isMain, parseArgs, readJson, readJsonl, writeJson } from "./lib/io.mjs";
import { capitalise, renderExamples } from "./draft-card.mjs";

/** Returns the card with `ids` appended to its Examples section. Throws on a non-train id, a duplicate, or a missing section. */
export function addExamples({ card, ids, pairsById, personaName }) {
  if (ids.length === 0) throw new Error("no ids given");
  if (new Set(ids).size !== ids.length) throw new Error("duplicate id in --ids");
  const outside = ids.filter((id) => !pairsById.has(id));
  if (outside.length) throw new Error(`not train reply ids: ${outside.join(", ")}`);
  const start = card.indexOf("\n## Examples\n");
  const end = card.indexOf("\n## ", start + 1);
  if (start === -1 || end === -1) throw new Error("card has no Examples section followed by another section");
  const section = card.slice(start, end);
  const already = ids.filter((id) => section.includes(renderExamples([id], pairsById, personaName)));
  if (already.length) throw new Error(`already in the card: ${already.join(", ")}`);
  return card.slice(0, end).trimEnd() + "\n\n" + renderExamples(ids, pairsById, personaName) + "\n" + card.slice(end);
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const version = Number(args["card-version"]);
  if (!Number.isInteger(version) || version < 1) throw new Error("--card-version <n> is required");
  if (typeof args.ids !== "string" || typeof args.reason !== "string") throw new Error("--ids <a,b> and --reason <text> are required");
  const data = args.data ?? "data/persona";
  const bank = join(data, "bank");
  const cardPath = join(data, "card", `v${version}.md`);
  const metaPath = join(data, "card", `v${version}.meta.json`);
  const train = new Set(readJson(join(bank, "splits.json")).replies.train);
  const pairsById = new Map(readJsonl(join(bank, "replies.jsonl")).filter((r) => train.has(r.id)).map((r) => [r.id, r]));
  const meta = readJson(metaPath);
  const personaName = meta.persona_name ?? capitalise(readJson(join(bank, "profile.json")).display_name);
  const ids = args.ids.split(",").map((s) => s.trim()).filter(Boolean);
  writeFileSync(cardPath, addExamples({ card: readFileSync(cardPath, "utf8"), ids, pairsById, personaName }));
  writeJson(metaPath, { ...meta, extra_example_ids: [...(meta.extra_example_ids ?? []), ...ids], extra_examples_reason: args.reason });
  console.log(`added ${ids.length} examples to ${cardPath}`);
}
