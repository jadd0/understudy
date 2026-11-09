// bank/splits.json: exactly paired text replies split by post, 60/20/20, with a fixed seed.
// Everything that is not an exact text pair (thread_first, non-text, top-level) is style_only:
// it feeds style figures and retrieval, never the card examples and never an evaluation.
import { join } from "node:path";
import { isMain, parseArgs, readJsonl, seededRng, shuffled, writeJson } from "./lib/io.mjs";

export const RATIOS = { train: 0.6, validation: 0.2, test: 0.2 };

/** An exact pair: a text reply that answers a known text comment. */
export function isExactPair(reply) {
  return (
    reply.kind === "reply" &&
    reply.replying_to_basis === "exact" &&
    !reply.non_text &&
    reply.text !== "" &&
    typeof reply.replying_to === "string" &&
    reply.replying_to !== "" &&
    !reply.replying_to_non_text
  );
}

export function splitReplies(replies, seed) {
  const postsWithPairs = [...new Set(replies.filter(isExactPair).map((r) => r.post_shortcode))].sort();
  const order = shuffled(postsWithPairs, seededRng(`${seed}:split`));
  const nTrain = Math.round(order.length * RATIOS.train);
  const nValidation = Math.round(order.length * RATIOS.validation);
  const posts = {
    train: order.slice(0, nTrain),
    validation: order.slice(nTrain, nTrain + nValidation),
    test: order.slice(nTrain + nValidation),
  };
  const postSplit = new Map();
  for (const [name, list] of Object.entries(posts)) for (const shortcode of list) postSplit.set(shortcode, name);

  const ids = { train: [], validation: [], test: [], style_only: [] };
  for (const reply of replies) {
    const name = isExactPair(reply) ? postSplit.get(reply.post_shortcode) : "style_only";
    ids[name].push(reply.id);
  }
  for (const list of [...Object.values(posts), ...Object.values(ids)]) list.sort();

  return {
    seed,
    ratios: RATIOS,
    counts: {
      posts: Object.fromEntries(Object.entries(posts).map(([k, v]) => [k, v.length])),
      replies: Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, v.length])),
    },
    posts,
    replies: ids,
  };
}

/** Reply id -> split name, for the scripts that need to ask "may I use this reply?". */
export function splitIndex(splits) {
  const index = new Map();
  for (const [name, list] of Object.entries(splits.replies)) for (const id of list) index.set(id, name);
  return index;
}

export function writeSplits({ bankDir, seed }) {
  const splits = splitReplies(readJsonl(join(bankDir, "replies.jsonl")), seed);
  writeJson(join(bankDir, "splits.json"), splits);
  return splits;
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const splits = writeSplits({ bankDir: args.bank ?? "data/persona/bank", seed: args.seed ?? "understudy-2026" });
  console.log(JSON.stringify(splits.counts));
}
