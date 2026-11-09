import { answerOf, type Decider, type DeciderResult } from "../ports/decider";
import { LEADS_TO_OFFER_QUESTION, VERIFY_QUESTIONS, VERIFY_QUESTIONS_PAID } from "../routing/questions";
import { MARKER_PATTERN, type JevLine } from "./thread";
import type { RouteName } from "../types";

export type VerifyFailure =
  | "empty"
  | "refusal_stop"
  | "money"
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
  | "reasks"
  | "offer_unsetup";

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

/** Deterministic checks that need no model. */
export function codeChecks(draft: string, neverList: readonly string[]): VerifyFailure[] {
  const failures: VerifyFailure[] = [];
  if (draft.trim().length === 0) failures.push("empty");
  if (mentionsMoney(draft)) failures.push("money");
  if (MARKER_PATTERN.test(draft)) failures.push("marker_echo");
  if (asksForMedia(draft)) failures.push("asks_media");
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
const QUALITY: readonly VerifyFailure[] = ["reasks", "offer_unsetup"];

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
    paid?: boolean;
    /** The draft is a boundary line: a refusal is expected and is not failed as one. */
    boundary?: boolean;
    /** The item the card will show, on an offer route: Jev checks the draft leads into it. */
    offer?: { title: string; teaser: string | null } | null;
  },
  now: () => number,
): Promise<VerifyOutcome> {
  const started = now();
  const early: VerifyFailure[] = [...codeChecks(input.draft, input.neverList)];
  if (input.stopReason === "refusal") early.push("refusal_stop");
  if (early.length > 0) return { ok: false, failures: early, jevOut: null, usage: null, ms: now() - started };

  const withOffer = input.route === "offer" && input.offer ? input.offer : null;
  const base = input.paid ? VERIFY_QUESTIONS_PAID : VERIFY_QUESTIONS;
  const questions = withOffer ? [...base, LEADS_TO_OFFER_QUESTION] : base;
  const state = { draft: input.draft, fan_message: input.fanMessage, earlier_messages: input.earlier };
  const offerItem = withOffer ? `${withOffer.title}${withOffer.teaser ? `: ${withOffer.teaser}` : ""}` : null;
  const result = await decider.ask(questions, { state: offerItem ? { ...state, offer_item: offerItem } : state });
  const failures = jevChecks(result, input.route, input.boundary === true);
  return {
    ok: failures.length === 0,
    failures,
    jevOut: Object.fromEntries(result.answers.map((a) => [a.key, a.value])),
    usage: result.usage,
    ms: now() - started,
  };
}
