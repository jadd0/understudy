import { answerOf, type Decider, type DeciderResult } from "../ports/decider.js";
import { namesMessagingApp, namesPaymentApp } from "../routing/offplatform.js";
import { LEADS_TO_OFFER_QUESTION, VERIFY_QUESTIONS } from "../routing/questions.js";
import { MARKER_PATTERN, type JevLine } from "./thread.js";
import { namesPet, type StyleDraw, type StyleRates } from "./style-draw.js";
import type { RouteName } from "../types.js";

export type VerifyFailure =
  | "empty"
  | "refusal_stop"
  | "money"
  | "off_app_payment"
  | "never_list"
  | "off_persona"
  | "explicit"
  | "offplatform_or_meetup"
  | "refusal"
  | "admits_ai_missing"
  | "admits_ai_unexpected"
  | "promises_price_or_free"
  | "marker_echo"
  | "asks_media"
  | "bio_link"
  | "reasks"
  | "offer_unsetup"
  | "too_long"
  | "pet_disallowed";

const CURRENCY_SYMBOL = /[$€£¥₹₩]/;
const CURRENCY_WORD = "usd|dollars?|bucks?|bux|euros?|eur|gbp|pounds?|quid|cents?";
const NUMBER_WORDS = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|thousand";
const NUMBER_THEN_WORD = new RegExp(`(?:\\d[\\d.,]*|(?<![a-z])(?:${NUMBER_WORDS}))\\s*(?:${CURRENCY_WORD})(?![a-z])`, "i");
const WORD_THEN_NUMBER = new RegExp(`(?<![a-z])(?:${CURRENCY_WORD})\\s*\\d`, "i");
/** A percentage, a price with two decimals, or a way of saying it costs nothing. */
const PERCENT = /\d\s*%/;
const DECIMAL_PRICE = /\d\.\d\d(?!\d)/;
const FREE_PHRASE = /(?<![a-z])(?:on\s+the\s+house|no\s+charge|for\s+free|gratis)(?![a-z])/i;

/** A currency symbol anywhere, or a currency word beside a number: the model never sees a price, so none should appear. */
export function mentionsMoney(text: string): boolean {
  return (
    CURRENCY_SYMBOL.test(text) ||
    NUMBER_THEN_WORD.test(text) ||
    WORD_THEN_NUMBER.test(text) ||
    PERCENT.test(text) ||
    DECIMAL_PRICE.test(text) ||
    FREE_PHRASE.test(text)
  );
}

/** A never-list term as a case-insensitive whole-word pattern; spaces inside a term may be missing or doubled, and a plural counts. */
export function neverTermPattern(term: string): RegExp {
  const body = term
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*");
  return new RegExp(`(?<![a-z0-9])${body}(?:e?s)?(?![a-z0-9])`, "i");
}

/**
 * Asking the fan to send media, which this chat cannot carry: "send me a pic", "loser has to send a voice note",
 * "drop a selfie", "show me a pic". A verb of sending near a media word, within a few words. "see" is left out: her own
 * pitch ("wanna see the rooftop pics") must pass.
 */
const MEDIA = "(?:pics?|pictures?|photos?|selfies?|vids?|videos?|voice\\s*notes?|voice\\s*messages?|vns?|snaps?)";
const SEND = "(?:send|sending|sends|drop|post|share|show\\s+me)";
const ASKS_MEDIA = new RegExp(`(?<![a-z])${SEND}(?:\\W+\\w+){0,4}?\\W+(?:a\\s+|an\\s+|some\\s+|me\\s+)?${MEDIA}(?![a-z])`, "i");
export function asksForMedia(text: string): boolean {
  return ASKS_MEDIA.test(text);
}

/**
 * A pointer to her bio link ("link in bio", "the link's in my bio"). Her sets are unlocked in this chat, so sending a fan
 * off to a bio link undercuts the sale, though saying where she posts is still allowed.
 */
const BIO_LINK = /(?<![a-z])links?(?:['’]s)?\s+(?:(?:is|are)\s+)?in\s+(?:(?:my|the|her)\s+)?bio(?![a-z])/i;
export function pointsToBioLink(text: string): boolean {
  return BIO_LINK.test(text);
}

/** An Identity line about a private way to reach her: a messaging app, or a private, personal, DM or contact account. */
const PRIVATE_CHANNEL = /(?<![a-z0-9])(?:private|personal|dms?|contact)(?![a-z0-9])/i;

/**
 * The accounts the persona card names as hers: the `@handle`s on the lines of its Identity section, which ends at the
 * next heading of any level. An `@` that follows a word character (an email address) and the placeholder `@user` are
 * not accounts, and neither is a handle on a line that names a messaging app or calls the account private, personal,
 * a DM or a contact: naming that one would be inviting him to talk off the app. Other sections only mention handles in
 * rules ("never start a reply with an @mention"), so they are not read.
 */
export function ownAccounts(cardBody: string): string[] {
  const lines = cardBody.split("\n");
  const start = lines.findIndex((l) => /^##\s+Identity\s*$/i.test(l));
  if (start === -1) return [];
  const found: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    if (namesMessagingApp(line) || PRIVATE_CHANNEL.test(line)) continue;
    for (const m of line.matchAll(/(?<![\w@])@([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/g)) {
      if (m[1].toLowerCase() !== "user" && !found.includes(m[0])) found.push(m[0]);
    }
  }
  return found;
}

/** Deterministic checks that need no model. */
export function codeChecks(draft: string, neverList: readonly string[]): VerifyFailure[] {
  const failures: VerifyFailure[] = [];
  if (draft.trim().length === 0) failures.push("empty");
  if (mentionsMoney(draft)) failures.push("money");
  // Paying her outside the app is a safety failure, like a price: no quality fallback sends it.
  if (namesPaymentApp(draft)) failures.push("off_app_payment");
  if (MARKER_PATTERN.test(draft)) failures.push("marker_echo");
  if (asksForMedia(draft)) failures.push("asks_media");
  if (pointsToBioLink(draft)) failures.push("bio_link");
  if (neverList.some((term) => term.trim() !== "" && neverTermPattern(term).test(draft))) failures.push("never_list");
  return failures;
}

/** Reads Jev's verdict on a draft. `admits_ai` must be yes on ai_disclosure and no on every other route. */
export function jevChecks(result: DeciderResult, route: RouteName, boundary = false): VerifyFailure[] {
  const v = (key: string) => answerOf(result, key).value;
  const failures: VerifyFailure[] = [];
  // An honest "i'm an ai" is out of character by definition, so Jev's persona check failed most disclosure drafts
  // and a sincere question went unanswered. On that route the admission is what is checked instead.
  if (route !== "ai_disclosure" && v("on_persona") !== "yes") failures.push("off_persona");
  if (v("explicitness") === "explicit") failures.push("explicit");
  if (v("offplatform_or_meetup") !== "no") failures.push("offplatform_or_meetup");
  // A boundary line is a refusal by design ("i can't meet up"); every other check still applies, and it must not invite.
  if (!boundary && v("is_refusal") !== "no") failures.push("refusal");
  const admits = v("admits_ai") === "yes";
  if (route === "ai_disclosure" && !admits) failures.push("admits_ai_missing");
  if (route !== "ai_disclosure" && admits) failures.push("admits_ai_unexpected");
  if (v("promises_price_or_free") !== "no") failures.push("promises_price_or_free");
  // Only "yes" fails: this check can cost a regeneration, never a handoff. The production decider throws
  // `malformed` when any answer is missing or off-option, so a dropped `reasks` there is an error, not a "no".
  if (result.answers.find((a) => a.key === "reasks")?.value === "yes") failures.push("reasks");
  // Asked only on an offer draft. A draft that never gets to the item is safe to send, but not with the card.
  const leads = result.answers.find((a) => a.key === "leads_to_offer");
  if (route === "offer" && leads && leads.value !== "yes") failures.push("offer_unsetup");
  return failures;
}

/** Failures that cost a regeneration but never make a draft unsafe to send. */
const QUALITY: readonly VerifyFailure[] = ["reasks", "offer_unsetup", "too_long", "pet_disallowed", "bio_link"];

/** A draft whose only failures are quality ones is still safe to send: the turn may regenerate, then sends it anyway. */
export const qualityOnly = (failures: readonly VerifyFailure[]): boolean => failures.length > 0 && failures.every((f) => QUALITY.includes(f));

export interface VerifyOutcome {
  ok: boolean;
  failures: VerifyFailure[];
  jevOut: Record<string, string> | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  ms: number;
}

/** Code checks first (a draft that fails them is not worth a Jev call), then Jev on the same draft. */
export async function verifyDraft(
  decider: Decider,
  input: {
    draft: string;
    fanMessage: string;
    earlier: readonly JevLine[];
    route: RouteName;
    neverList: readonly string[];
    stopReason: string | null;
    /** The draft is a boundary line: a refusal is expected and is not failed as one. */
    boundary?: boolean;
    /** The item the card will show, on an offer route: Jev checks the draft leads into it. */
    offer?: { title: string; teaser: string | null } | null;
    /** Whose chat the draft is for, passed to the decider so a per-creator adapter can attribute the call. */
    creatorId?: string;
    /** The accounts the card names as hers, told to Jev so naming one is not read as sending him to a private account. */
    ownAccounts?: readonly string[];
  },
  now: () => number,
): Promise<VerifyOutcome> {
  const started = now();
  const early: VerifyFailure[] = [...codeChecks(input.draft, input.neverList)];
  if (input.stopReason === "refusal") early.push("refusal_stop");
  // A draft that fails only a quality check is still safe to send, so it still goes to Jev: the safety checks must
  // judge every draft that can be sent.
  if (early.some((f) => !QUALITY.includes(f))) return { ok: false, failures: early, jevOut: null, usage: null, ms: now() - started };

  const withOffer = input.route === "offer" && input.offer ? input.offer : null;
  const questions = withOffer ? [...VERIFY_QUESTIONS, LEADS_TO_OFFER_QUESTION] : VERIFY_QUESTIONS;
  const accounts = input.ownAccounts ?? [];
  const state = {
    draft: input.draft,
    fan_message: input.fanMessage,
    earlier_messages: input.earlier,
    ...(accounts.length > 0 ? { her_accounts: accounts } : {}),
  };
  const offerItem = withOffer ? `${withOffer.title}${withOffer.teaser ? `: ${withOffer.teaser}` : ""}` : null;
  const result = await decider.ask(questions, {
    state: offerItem ? { ...state, offer_item: offerItem } : state,
    creatorId: input.creatorId,
  });
  const failures = [...early, ...jevChecks(result, input.route, input.boundary === true)];
  return {
    ok: failures.length === 0,
    failures,
    jevOut: Object.fromEntries(result.answers.map((a) => [a.key, a.value])),
    usage: result.usage,
    ms: now() - started,
  };
}

/** What may follow a word at the end of a bubble without it being mid-sentence: spaces, punctuation, emoji. */
const TAIL = String.raw`(?=[\s\p{P}\p{Extended_Pictographic}\u{FE0F}]*$)`;
const SIGNOFF_AT_END = new RegExp(String.raw`\s*(?<![\p{L}\p{N}])x{1,3}(?![\p{L}\p{N}])${TAIL}`, "iu");
const addressAtEnd = (term: string) => new RegExp(String.raw`,?\s*(?<![\p{L}\p{N}])${term}(?![\p{L}\p{N}])${TAIL}`, "iu");
// "mate, …" and "mate that's mad" open with an address; "mate of mine" and "mate's van" use it as a noun and stay.
const addressAtStart = (term: string) => new RegExp(String.raw`^\s*${term}(?![\p{L}\p{N}'’])(?:\s*,\s*|\s+(?!of\b))`, "iu");

const EMOJI = /\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\u{FE0F}|\p{Emoji_Modifier})?(?:\u{200D}\p{Extended_Pictographic}(?:\u{FE0F}|\p{Emoji_Modifier})?)*/gu;
const hasContent = (s: string) => /[\p{L}\p{N}]/u.test(s);

/** The reply's length as a fan sees it: characters, with any run of whitespace (a line break included) as one space. */
const lengthOf = (draft: string): number => [...draft.replace(/\s+/g, " ").trim()].length;

/**
 * The draw's length and pet limits, which code cannot enforce without breaking a sentence: a reply longer than
 * max(2 x the target, her p90), and one that names her pet when the draw did not allow it. Both are quality-only, so a
 * draft that fails only these is still sent when no attempt does better. Nothing is checked without a draw.
 */
export function drawFailures(draft: string, draw: StyleDraw | null, rates: StyleRates | null): VerifyFailure[] {
  if (!draw || !rates) return [];
  const failures: VerifyFailure[] = [];
  if (draw.targetChars !== undefined && rates.length && lengthOf(draft) > Math.max(2 * draw.targetChars, rates.length.p90)) failures.push("too_long");
  if (!draw.petName && namesPet(draft, rates.pet)) failures.push("pet_disallowed");
  return failures;
}

/**
 * Removes an emoji the draw did not allow, a sign-off x or an address term ("mate", "babe") it did not allow, from
 * the edges of the reply only: a closing x on the last bubble, and a term that opens or closes any bubble. Nothing
 * mid-sentence is touched. A reply the draw keeps to one line is joined with spaces. A change that would leave a
 * bubble or the whole reply without a letter or digit is not made, so a reply is never emptied here (a bare emoji
 * answer stays); the normal checks already ran on the draft.
 */
export function enforceDraw(draft: string, draw: StyleDraw): string {
  let source = draft;
  if (!draw.emoji) {
    const stripped = draft
      .split("\n")
      .map((l) => l.replace(EMOJI, "").replace(/[ \t]{2,}/g, " ").replace(/^[ \t]+|[ \t]+$/gu, ""))
      .filter((l) => l !== "")
      .join("\n");
    if (hasContent(stripped)) source = stripped;
  }
  const lines = source.split("\n");
  const out = lines.map((line, i) => {
    let next = line;
    const attempt = (re: RegExp) => {
      const trimmed = next.replace(re, "");
      // A bubble keeps at least one letter or digit; an edit that leaves only emoji or punctuation is not made.
      if (/[\p{L}\p{N}]/u.test(trimmed) && trimmed !== next) next = trimmed.replace(/^[ \t]+|[ \t]+$/gu, "");
    };
    if (!draw.signoff && i === lines.length - 1) attempt(SIGNOFF_AT_END);
    for (const term of ["mate", "babe"] as const) {
      if (draw.address === term) continue;
      attempt(addressAtEnd(term));
      attempt(addressAtStart(term));
    }
    return next;
  });
  const kept = draw.multiline === false ? out.map((l) => l.trim()).filter((l) => l !== "") : out;
  const joined = kept.join(draw.multiline === false ? " " : "\n");
  return joined.trim() === "" ? draft : joined;
}
