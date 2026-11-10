// Drafts the persona card (card/v<N>.md) with Claude from the bank. The card is the script's
// output and is never edited by hand: a change goes into the prompt below, then a re-run.
//
// Inputs the model sees: style.json, every post (captions marked voice or not, descriptions,
// location: the facts), the profile bio without contact details, and the TRAIN exact reply
// pairs. Validation and test replies are never read here. The Examples section is rendered by
// this script from train pair ids the model picks, so the examples are verbatim by construction.
//
// With fewer than MIN_PAIRS train pairs (an Instagram data download holds the comments she wrote
// but not the ones they answered) the prompt is the same text with two swaps: the pairs block
// becomes her own lines, and the examples are picked from those lines.
import { join } from "node:path";
import { isMain, loadEnvFile, parseArgs, readJson, readJsonl, sha256Hex, TokenBudget, writeJson } from "./lib/io.mjs";
import { createClaude } from "./lib/claude.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

export const SECTIONS = ["Identity", "Voice rules", "Examples", "Not known", "Never", "Selling voice", "AI honesty"];
const PLACEHOLDER = "<<EXAMPLES>>";
/** Train pairs needed for the pairs prompt; below this the lines prompt is used. */
export const MIN_PAIRS = 15;
const MAX_EXAMPLES = 20;
// The two texts the lines prompt swaps. They repeat the pairs prompt word for word on purpose: a change to
// that prompt that is not made here too makes linesPrompt throw instead of quietly sending a mixed prompt.
const PAIRS_HEADER = "=== PAIRS (fan comment and her reply; train split) ===";
const LINES_HEADER = "=== HER LINES (her own comments; the comment each answered is not known) ===";
const EXAMPLES_PARAGRAPH =
  "After the card, on its own final line, write EXAMPLE_IDS: followed by 15 to 20 comma-separated reply pair ids from the pairs list below, chosen to show her range (greeting, thanks, flirt, banter, one-word answers, a question back). Prefer pairs that are friendly or flirty and not explicit.";
const NO_EXAMPLES = "No examples: the data holds no lines of hers.";

export function capitalise(name) {
  return name ? name[0].toUpperCase() + name.slice(1) : name;
}

function system(personaName) {
  return `You write persona cards: the briefing a reply-writing model reads before it chats as a real creator, in the creator's own voice, with her fans. You are drafting the card for ${personaName} from measured data. Rules:
- Use only what the data states. Never invent a fact about her. Where a fact is not in the data, it belongs under "Not known".
- Every Voice rule cites a figure from the style data in the form (style: replies.lowercase_only_rate = 0.93), using the exact key path and value.
- The card must not contain any explicit sexual text. Flirty and teasing is in; anything explicit is out, in the card text and in the examples you choose.
- Write the card as direct instructions to the reply model ("you"), concise, in markdown.`;
}

export function userPrompt({ personaName, style, profile, posts, pairs }) {
  const postLines = posts
    .map((p) => {
      const tag = p.voice ? "her caption" : p.collab ? "collab, caption NOT hers" : "no caption";
      return `[${p.id}] ${p.date} ${p.type} (${tag})${p.location ? ` @ ${p.location}` : ""}: ${p.caption || "(none)"} | image: ${p.description || "(none)"}`;
    })
    .join("\n");
  const pairLines = pairs.map((r) => `[${r.id}] fan: ${r.replying_to}\n    ${personaName}: ${r.text}`).join("\n");
  return `Draft the card for ${personaName}. Output exactly these markdown sections, in this order, each as a level-2 heading:

## Identity
Facts about her, each one a bullet ending with its source as (src: <shortcode>) using a shortcode from the posts list, or (src: profile) for the bio. Facts only: where she lives or is from if the bio says so, language, what she posts, recurring themes, names of her accounts.
## Voice rules
Rules for how she writes, each citing a style figure. Cover case, length, emoji, emoticons, slang and tokens, Spanish, questions and exclamations, how she reacts to song lyrics or "sing this" (if the pairs show it, she plays along: make it a rule).
This card is for one-to-one paid DMs, not Instagram comments. Her comment replies start with an @mention only because Instagram inserts it (replies.leading_mention_rate): never start a reply with an @mention or the fan's handle, and don't write an opening rule about mentions.
Length in DMs: one or two short sentences, each still in her terse style (cite replies.length_chars for how short a sentence is). Each sentence is sent as its own message bubble, so write each sentence on its own line, at most 2 lines.
## Examples
Write only this exact line under the heading: ${PLACEHOLDER}
## Not known
What the reply model must deflect rather than invent: age, relationship status, address, anything not stated in Identity. Say how to deflect in her voice.
## Never
Contact details, her home location, real-world meetups, off-platform payment.
## Selling voice
How she teases a paid item or a catalogue unlock: flirty, never explicit text, then the paid thing does the rest. Include how she checks in after a fan unlocks something (a playful "did u like it" in her voice) and how she thanks a tip.
## AI honesty
If a fan sincerely asks whether he is talking to an AI, she says so truthfully, still in her own voice: an AI helping her chat.

After the card, on its own final line, write EXAMPLE_IDS: followed by 15 to 20 comma-separated reply pair ids from the pairs list below, chosen to show her range (greeting, thanks, flirt, banter, one-word answers, a question back). Prefer pairs that are friendly or flirty and not explicit.

=== STYLE DATA (style.json) ===
${JSON.stringify(style)}

=== PROFILE ===
display name: ${profile.display_name}; category: ${profile.category}; bio: ${JSON.stringify(profile.bio)}; links: ${profile.links.map((l) => l.text).join(", ")}

=== POSTS (the facts) ===
${postLines}

=== PAIRS (fan comment and her reply; train split) ===
${pairLines}`;
}

function swapOnce(text, from, to) {
  const parts = text.split(from);
  if (parts.length !== 2) throw new Error(`lines prompt: expected one match, found ${parts.length - 1}`);
  return parts.join(to);
}

/** How many example ids a card names: 15 to 20, or all of her lines when she has fewer. */
export function exampleRange(lineCount) {
  return { min: Math.min(MIN_PAIRS, lineCount), max: Math.min(MAX_EXAMPLES, lineCount) };
}

/** The pairs prompt with her own lines in place of the pairs. */
function linesPrompt({ personaName, style, profile, posts, lines }) {
  const { min, max } = exampleRange(lines.length);
  const instruction =
    lines.length === 0
      ? "After the card, on its own final line, write EXAMPLE_IDS: and nothing after it, because her lines list below is empty."
      : `After the card, on its own final line, write EXAMPLE_IDS: followed by ${min} to ${max} comma-separated line ids from the list of her lines below, chosen to show her range (greeting, thanks, flirt, banter, one-word answers, a question back). Prefer lines that are friendly or flirty and not explicit.`;
  const block = lines.map((line) => `[${line.id}] ${personaName}: ${line.text}`).join("\n");
  const base = userPrompt({ personaName, style, profile, posts, pairs: [] });
  return swapOnce(swapOnce(base, EXAMPLES_PARAGRAPH, instruction), `${PAIRS_HEADER}\n`, `${LINES_HEADER}\n${block}`);
}

/** Her own text comments, train and style-only, without the @mention Instagram inserts, each wording once. */
export function herLines(replies, splits) {
  const eligible = new Set([...splits.replies.train, ...splits.replies.style_only]);
  const seen = new Set();
  const lines = [];
  for (const reply of replies) {
    if (!eligible.has(reply.id) || reply.non_text) continue;
    const text = stripLeadingMentions(reply.text ?? "");
    if (text === "" || seen.has(text)) continue;
    seen.add(text);
    lines.push({ id: reply.id, text });
  }
  return lines;
}

/** Instagram inserts "@handle " at the start of a comment reply; DMs never have it. */
export function stripLeadingMentions(text) {
  return text.replace(/^(\s*@[\w.]+\s*)+/, "").trim();
}

export function renderExamples(ids, byId, personaName, mode = "pairs") {
  if (mode === "lines") {
    return ids.length === 0 ? NO_EXAMPLES : ids.map((id) => `**${personaName}:** ${byId.get(id).text}`).join("\n\n");
  }
  return ids
    .map((id) => `**Fan:** ${stripLeadingMentions(byId.get(id).replying_to)}\n**${personaName}:** ${stripLeadingMentions(byId.get(id).text)}`)
    .join("\n\n");
}

/** Parses and checks the model output; throws on anything structural, returns warnings for the rest. */
export function assembleCard({ raw, pairsById, shortcodes, personaName, mode = "pairs" }) {
  const lines = raw.trimEnd().split("\n");
  const idLine = lines.findLastIndex((line) => line.startsWith("EXAMPLE_IDS:"));
  if (idLine === -1) throw new Error("card output has no EXAMPLE_IDS line");
  const ids = lines[idLine].slice("EXAMPLE_IDS:".length).split(",").map((s) => s.trim()).filter(Boolean);
  const body = lines.slice(0, idLine).join("\n").trim();

  if (new Set(ids).size !== ids.length) throw new Error("EXAMPLE_IDS has duplicates");
  const { min, max } = mode === "lines" ? exampleRange(pairsById.size) : { min: MIN_PAIRS, max: MAX_EXAMPLES };
  if (ids.length < min || ids.length > max) throw new Error(`EXAMPLE_IDS has ${ids.length} ids, expected ${min} to ${max}`);
  const outsideTrain = ids.filter((id) => !pairsById.has(id));
  if (outsideTrain.length) {
    throw new Error(`EXAMPLE_IDS names ${outsideTrain.length} ids outside ${mode === "lines" ? "her lines" : "the train pairs"}`);
  }

  const headings = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  if (headings.join("|") !== SECTIONS.join("|")) throw new Error(`card sections are [${headings.join(", ")}]`);
  if (body.split(PLACEHOLDER).length !== 2) throw new Error("card must contain the examples placeholder exactly once");

  const card = body.replace(PLACEHOLDER, renderExamples(ids, pairsById, personaName, mode)) + "\n";
  const cited = [...card.matchAll(/\(src: ([^)]+)\)/g)].flatMap((m) => m[1].split(/[,;]/).map((s) => s.trim()));
  const unknown = [...new Set(cited.filter((c) => c !== "profile" && !shortcodes.has(c)))];
  return { card, exampleIds: ids, warnings: unknown.length ? [`unknown source shortcodes: ${unknown.join(", ")}`] : [] };
}

export async function draftCard({ bankDir, cardDir, claude, model, version, budget, seed, personaName }) {
  const captions = readJsonl(join(bankDir, "captions.jsonl"));
  const replies = readJsonl(join(bankDir, "replies.jsonl"));
  const splits = readJson(join(bankDir, "splits.json"));
  const style = readJson(join(bankDir, "style.json"));
  const profile = readJson(join(bankDir, "profile.json"));
  const name = personaName ?? capitalise(profile.display_name);

  const trainIds = new Set(splits.replies.train);
  const pairs = replies.filter((r) => trainIds.has(r.id));
  const mode = pairs.length >= MIN_PAIRS ? "pairs" : "lines";
  const lines = mode === "lines" ? herLines(replies, splits) : [];
  const pairsById = new Map((mode === "lines" ? lines : pairs).map((r) => [r.id, r]));

  const prompt =
    mode === "lines"
      ? linesPrompt({ personaName: name, style, profile, posts: captions, lines })
      : userPrompt({ personaName: name, style, profile, posts: captions, pairs });
  const result = await claude.complete({ model, system: system(name), prompt, maxTokens: 16000 });
  budget.addClaude(result.usage);
  if (result.stopReason === "max_tokens") throw new Error("card output was cut off at max_tokens");

  const assembled = assembleCard({ raw: result.text, pairsById, shortcodes: new Set(captions.map((c) => c.id)), personaName: name, mode });
  mkdirSync(cardDir, { recursive: true });
  writeFileSync(join(cardDir, `v${version}.md`), assembled.card);
  writeJson(join(cardDir, `v${version}.meta.json`), {
    version,
    card_model: model,
    resolved_model: result.model,
    seed,
    persona_name: name,
    prompt_sha256: sha256Hex(prompt),
    input: {
      posts: captions.length,
      train_reply_ids: pairs.map((r) => r.id),
      example_ids: assembled.exampleIds,
      ...(mode === "lines" ? { example_mode: "lines", line_ids: lines.map((l) => l.id) } : {}),
    },
    warnings: assembled.warnings,
    usage: result.usage,
  });
  return assembled;
}

if (isMain(import.meta.url)) {
  loadEnvFile(".env.local");
  const args = parseArgs(process.argv.slice(2));
  if (typeof args["card-model"] !== "string") throw new Error("--card-model <id> is required");
  const data = args.data ?? "data/persona";
  const out = await draftCard({
    bankDir: join(data, "bank"),
    cardDir: join(data, "card"),
    claude: createClaude(),
    model: args["card-model"],
    version: Number(args["card-version"] ?? 1),
    budget: new TokenBudget(),
    seed: args.seed ?? "understudy-2026",
  });
  console.log(JSON.stringify({ examples: out.exampleIds.length, warnings: out.warnings }));
}
