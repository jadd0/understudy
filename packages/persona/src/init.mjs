// Builds a new creator's persona bank and drafts her card, from a raw directory already on disk
// (an Instagram export or an own-account scrape). It runs the stages that need no validation
// pairs and stops at the card: nothing here evaluates, queries or touches a database.
//
//   <dir>/raw   -> <dir>/bank/{captions,replies,profile,splits,style,chunks}  -> <dir>/card/v1.md
import { join } from "node:path";
import { normalise } from "./normalise.mjs";
import { writeSplits } from "./split.mjs";
import { writeStyle } from "./style.mjs";
import { writeChunks } from "./chunks.mjs";
import { draftCard } from "./draft-card.mjs";
import { TokenBudget } from "./lib/io.mjs";

/**
 * @param {{ dir: string, handle: string, claude: import("./index").Claude, cardModel: string, budget?: TokenBudget, seed?: string }} options
 */
export async function draftPersona({ dir, handle, claude, cardModel, budget = new TokenBudget(), seed = "understudy-2026" }) {
  const rawDir = join(dir, "raw");
  const bankDir = join(dir, "bank");
  const cardDir = join(dir, "card");
  const { counts } = normalise({ rawDir, outDir: bankDir, creator: handle });
  const splits = writeSplits({ bankDir, seed });
  const style = writeStyle({ bankDir });
  const chunks = writeChunks({ bankDir, label: handle });
  const card = await draftCard({ bankDir, cardDir, claude, model: cardModel, version: 1, budget, seed });
  return {
    counts,
    pairs: splits.counts.replies.train,
    chunks: chunks.length,
    markerTexts: style.markers?.n ?? 0,
    exampleIds: card.exampleIds.length,
    warnings: card.warnings,
    tokens: budget.used,
  };
}
