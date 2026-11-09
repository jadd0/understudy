// bank/style.json: measured style figures, captions and replies reported separately.
//
// Replies feed the figures only when they are train or style_only: validation and test replies
// are held out, so the card's voice rules cannot be derived from them. Figures are measured on
// the text with @mentions and urls removed, so who she addressed does not move length or case.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isMain, parseArgs, readJson, readJsonl, writeJson } from "./lib/io.mjs";
import { splitIndex } from "./split.mjs";

const EMOJI = /\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)*/gu;

// Written so a standalone token matches and the same characters inside a word do not
// (":3" must not match inside "12:30").
const EMOTICONS = [
  [":3", /(?<![\p{L}\p{N}]):3(?![\p{L}\p{N}])/gu],
  [">.<", />\.</g],
  [":)", /:\)/g],
  ["xD", /(?<![\p{L}\p{N}])xd(?![\p{L}\p{N}])/giu],
  ["rawr", /(?<![\p{L}\p{N}])rawr+(?![\p{L}\p{N}])/giu],
];

export const STOPWORDS = new Set(
  (
    "a about after all also am an and any are aren't as at be because been but by can can't could did didn't do does " +
    "doesn't don't for from get got had has have he her here him his how i i'm i've if in into is isn't it it's its just " +
    "me my no not of on one or our out she so some than that that's the their them then there they this to too up us " +
    "was we were what when where which who why will with would you your you're"
  ).split(" "),
);

// Small and deliberately avoids words that are also English (no "me", "no", "la", "a").
const SPANISH = new Set(
  (
    "que qué te mi mis tu tus pero gracias hola amor bebe bebé mami mamá papi sí muy está con para por como cómo eres " +
    "soy quiero bonita hermosa lindo linda guapa guapo jaja jajaja jajaj gracia mucho muchas todo todas nada siempre " +
    "buenos buenas dias días noches"
  ).split(" "),
);

// Voice markers a blind judge can count. Each is tested on the cleaned text of one reply, so a reply
// counts once however often it uses the marker. A sign-off is a trailing x/xx/xxx (optionally followed
// by punctuation or an emoji): "xmas" and "xD" are not.
export const SIGNOFF_X = /(?<![\p{L}\p{N}])x{1,3}(?![\p{L}\p{N}])[\s\p{P}\p{Extended_Pictographic}️]*$/iu;
export const MATE = /(?<![\p{L}\p{N}])mate(?![\p{L}\p{N}])/iu;
export const BABE = /(?<![\p{L}\p{N}])babe(?![\p{L}\p{N}])/iu;
// A price, or a capitalised word that is not the first of its sentence (a shop, a place); the pet's name does not count.
const PRICE = /[£$€]\s?\d|(?<![\p{L}\p{N}])\d[\d.,]*\s?(?:quid|pounds|p|k)(?![\p{L}\p{N}])/iu;
const CAPITALISED = /(?<=[\p{L}\p{N},;:] )\p{Lu}[\p{L}]+/gu;

/** The pet's name as it appears in the profile bio ("biscuit's assistant"), lower case, or null. */
export function petFromProfile(profile) {
  const m = /([\p{L}]+)['’]s assistant/iu.exec(profile?.bio ?? "");
  return m ? m[1].toLowerCase() : null;
}

const escapeRe = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does `text` use the pet's name (whole word, any case)? */
export function usesPetName(text, pet) {
  if (!pet) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(pet)}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

/** Whether one reply carries a concrete fact: a price, or a capitalised place or shop name. */
export function usesConcreteFact(text, pet) {
  if (PRICE.test(text)) return true;
  return [...text.matchAll(CAPITALISED)].some((m) => m[0].toLowerCase() !== (pet ?? "") && m[0] !== "I");
}

/** Share of replies using each marker, on the cleaned text. Rates are shares of texts, 4 places. */
export function measureMarkers(texts, pet) {
  const counts = { signoff_x: 0, mate: 0, babe: 0, pet_name: 0, emoji: 0, concrete_fact: 0 };
  for (const raw of texts) {
    const text = cleaned(raw);
    if (SIGNOFF_X.test(text)) counts.signoff_x++;
    if (MATE.test(text)) counts.mate++;
    if (BABE.test(text)) counts.babe++;
    if (usesPetName(text, pet)) counts.pet_name++;
    if ([...text.matchAll(EMOJI)].length > 0) counts.emoji++;
    if (usesConcreteFact(text, pet)) counts.concrete_fact++;
  }
  return {
    n: texts.length,
    pet,
    ...Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, rate(v, texts.length)])),
  };
}

export function percentile(sortedAscending, p) {
  if (sortedAscending.length === 0) return null;
  const rank = Math.ceil(p * sortedAscending.length);
  return sortedAscending[Math.max(0, rank - 1)];
}

function cleaned(text) {
  return text.replace(/https?:\/\/\S+/g, " ").replace(/@[\p{L}\p{N}_.]+/gu, " ").replace(/\s+/g, " ").trim();
}

function tokens(text) {
  return (text.toLowerCase().replace(/’/g, "'").match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) ?? []).filter(
    (token) => !/^\p{N}+$/u.test(token),
  );
}

function rate(count, total) {
  return total === 0 ? null : Math.round((count / total) * 10000) / 10000;
}

function topCounts(counter, limit, key) {
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([name, count]) => ({ [key]: name, count }));
}

export function measure(texts) {
  const emoji = new Map();
  const words = new Map();
  const emoticons = Object.fromEntries(EMOTICONS.map(([name]) => [name, 0]));
  const lengths = [];
  let lettered = 0;
  let lowercase = 0;
  let questions = 0;
  let withEmoji = 0;
  let exclamations = 0;
  let allTokens = 0;
  let spanish = 0;
  let leadingMention = 0;

  for (const raw of texts) {
    if (/^\s*@\S+/.test(raw)) leadingMention++;
    const text = cleaned(raw);
    lengths.push([...text].length);
    if (/\p{L}/u.test(text)) {
      lettered++;
      if (text === text.toLowerCase()) lowercase++;
    }
    if (text.includes("?")) questions++;
    if ([...text.matchAll(EMOJI)].length > 0) withEmoji++;
    if (text.includes("!")) exclamations++;
    for (const match of text.matchAll(EMOJI)) emoji.set(match[0], (emoji.get(match[0]) ?? 0) + 1);
    for (const [name, pattern] of EMOTICONS) emoticons[name] += (text.match(pattern) ?? []).length;
    for (const token of tokens(text)) {
      allTokens++;
      if (SPANISH.has(token)) spanish++;
      if (!STOPWORDS.has(token) && token.length > 1) words.set(token, (words.get(token) ?? 0) + 1);
    }
  }
  lengths.sort((a, b) => a - b);
  return {
    n: texts.length,
    lowercase_only_rate: rate(lowercase, lettered),
    length_chars: { p50: percentile(lengths, 0.5), p90: percentile(lengths, 0.9) },
    top_emoji: topCounts(emoji, 15, "emoji"),
    emoticons,
    top_tokens: topCounts(words, 40, "token"),
    spanish_token_rate: rate(spanish, allTokens),
    question_rate: rate(questions, texts.length),
    exclamation_rate: rate(exclamations, texts.length),
    with_emoji_rate: rate(withEmoji, texts.length),
    leading_mention_rate: rate(leadingMention, texts.length),
  };
}

export function computeStyle({ captions, replies, splits, pet = null }) {
  const index = splitIndex(splits);
  const used = replies.filter((r) => ["train", "style_only"].includes(index.get(r.id)));
  const usedText = used.filter((r) => !r.non_text && r.text !== "");
  const heldOut = replies.filter((r) => ["validation", "test"].includes(index.get(r.id)));
  return {
    method:
      "Figures are measured with mentions and urls removed. Replies exclude the validation and test splits. Rates are shares of texts, rounded to 4 places; markers are measured on the same replies; length is characters, nearest-rank percentiles.",
    captions: measure(captions.filter((c) => c.voice).map((c) => c.caption)),
    markers: measureMarkers(usedText.map((r) => r.text), pet),
    replies: {
      ...measure(usedText.map((r) => r.text)),
      counts: {
        text_used: usedText.length,
        non_text: replies.filter((r) => r.non_text).length,
        text_held_out: heldOut.filter((r) => !r.non_text).length,
      },
    },
  };
}

export function writeStyle({ bankDir }) {
  const style = computeStyle({
    captions: readJsonl(join(bankDir, "captions.jsonl")),
    replies: readJsonl(join(bankDir, "replies.jsonl")),
    splits: readJson(join(bankDir, "splits.json")),
    pet: petFromProfile(existsSync(join(bankDir, "profile.json")) ? readJson(join(bankDir, "profile.json")) : null),
  });
  writeJson(join(bankDir, "style.json"), style);
  return style;
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const style = writeStyle({ bankDir: args.bank ?? "data/persona/bank" });
  console.log(JSON.stringify({ captions: style.captions.n, replies: style.replies.n }));
}
