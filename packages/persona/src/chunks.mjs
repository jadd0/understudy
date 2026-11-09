// bank/chunks.jsonl: the retrieval corpus. One chunk per post (caption plus image description)
// and one per train or style_only text reply pair. Validation and test replies never enter.
import { join } from "node:path";
import { isMain, parseArgs, readJson, readJsonl, writeJsonl } from "./lib/io.mjs";
import { splitIndex } from "./split.mjs";

export function buildChunks({ captions, replies, splits, label = "juno" }) {
  const index = splitIndex(splits);
  const urls = new Map(captions.map((c) => [c.id, c.source_url]));
  const chunks = [];

  for (const c of captions) {
    const head = c.caption ? `${c.date} ${c.type}: ${c.caption}` : `${c.date} ${c.type}:`;
    chunks.push({
      id: `cap_${c.id}`,
      source: "caption",
      source_url: c.source_url,
      date: c.date,
      post_shortcode: c.id,
      split: null,
      text: c.description ? `${head} — ${c.description}` : head,
    });
  }

  for (const r of replies) {
    const split = index.get(r.id);
    if (split !== "train" && split !== "style_only") continue;
    if (r.non_text || r.text === "" || !r.replying_to) continue;
    chunks.push({
      id: `rep_${r.id}`,
      source: "comment_reply",
      source_url: urls.get(r.post_shortcode) ?? null,
      date: r.date.slice(0, 10),
      post_shortcode: r.post_shortcode,
      split,
      text: `fan: ${r.replying_to} / ${label}: ${r.text}`,
    });
  }
  return chunks;
}

export function writeChunks({ bankDir, label }) {
  const chunks = buildChunks({
    captions: readJsonl(join(bankDir, "captions.jsonl")),
    replies: readJsonl(join(bankDir, "replies.jsonl")),
    splits: readJson(join(bankDir, "splits.json")),
    label,
  });
  writeJsonl(join(bankDir, "chunks.jsonl"), chunks);
  return chunks;
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const chunks = writeChunks({ bankDir: args.bank ?? "data/persona/bank", label: args.label });
  console.log(JSON.stringify({ chunks: chunks.length }));
}
