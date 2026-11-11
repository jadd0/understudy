/**
 * Words that move the money or the chat off this app, as a code check beside the money fence. They are code, not
 * config: they decide a safety outcome (a confident buy ask is only exempt from a strike without them, and a draft that
 * names a payment app never goes out). Every pattern is a case-insensitive whole word, so "meeting" is not "meet" and
 * "snapped" is not "snap".
 */
const whole = (alternatives: string): RegExp => new RegExp(`(?<![a-z0-9])(?:${alternatives})(?![a-z0-9])`, "i");

/**
 * A payment app, a transfer or crypto, or paying her directly. "wise" is an ordinary word ("wise choice"), so it
 * counts only beside the way a payment names it ("on wise", "wise transfer"). Apple Pay and Google Pay are left out:
 * they are how a fan tops up inside this app.
 */
const PAYMENT = whole(
  [
    "c[a@]sh[\\s-]*app",
    "cashtag",
    "venmo",
    "pay\\s*pal",
    "pp\\s+me",
    "zelle",
    "revolut",
    "western\\s+union",
    "apple\\s+cash",
    "gift\\s*cards?",
    "(?:bank|wire)\\s+transfers?",
    "bank\\s+(?:details|account)",
    "crypto",
    "btc",
    "bitcoin",
    "usd[tc]",
    "(?:on|via)\\s+wise",
    "wise\\s+(?:transfer|account)",
    "send\\s+it\\s+(?:to|on|through|via)\\s+wise",
    "pay(?:ing)?(?:\\s+(?:you|u|ya|her|me))?\\s+(?:direct(?:ly)?|outside)",
  ].join("|"),
);

/**
 * The names of messaging apps, with the abbreviations fans use. "wa me" and "what's app" are how the app gets named when
 * the spelling is dodged.
 */
const APP_NAMES = "snapchat|telegram|tele|tg|what['\u2019]?s\\s*app|wa\\s+me|kik|discord";

/**
 * A messaging app she could be asked to move to, written as a contact. "snap" and "signal" are ordinary words (photos,
 * a signal), so they count only in the way an account is offered or asked for: "add me on snap", "my snap", "on signal".
 */
const MESSAGING = whole(
  [
    APP_NAMES,
    "(?:add|hmu|dm|message|msg)\\s+(?:me\\s+)?(?:on|at|via)\\s+snap",
    "(?:my|ur|your)\\s+snap",
    "snap\\s+me",
    "snap\\s*:",
    "on\\s+signal",
    "signal\\s+app",
  ].join("|"),
);

/** An app named on a line of her own persona card, where a bare "snap" or "signal" is a label for an account. */
const CARD_MESSAGING = whole(`${APP_NAMES}|snaps?|signal`);

/**
 * Asking for, or offering, a way to reach her outside the chat. "number" and "phone" count only as a contact ("ur
 * number", "phone number", "text me"): a phone is also where he watches the video.
 */
const CONTACT = whole(
  [
    "(?:ur|your|my)\\s+(?:numbers?|num|digits)",
    "phone\\s+numbers?",
    "(?:give|gimme|send)\\s+(?:me\\s+)?(?:ur|your)\\s+phone",
    "text\\s+me",
    "call\\s+me",
    "e-?mails?",
    "add\\s+me",
    "dm\\s+me\\s+on\\s+insta(?:gram)?",
  ].join("|"),
);

const MEET_VERB = "meet(?:\\s+(?:me|u|you))?|come\\s+(?:over|round|around)|see\\s+(?:you|u)";

/**
 * Wanting to be somewhere with her. "meet" and "tonight" are ordinary words ("nice to meet you"), so they count only in
 * a plan to meet ("meet up", "let's meet", "meet me") or beside one ("come over tonight").
 */
const MEETUP = whole(
  [
    "meet[\\s-]*ups?",
    "meet\\s+me",
    "(?:let['\u2019]?s|lets|wanna|want\\s+to|can\\s+we|could\\s+we|should\\s+we)\\s+meet",
    "meet\\s+(?:irl|in\\s+person)",
    "come\\s+(?:over|round|around)",
    `(?:${MEET_VERB})(?:\\s+\\w+){0,3}\\s+tonight`,
    `tonight(?:\\s+\\w+){0,3}?\\s+(?:${MEET_VERB})`,
    "(?:my|ur|your)\\s+place",
    "irl",
    "in\\s+real\\s+life",
    "in\\s+person",
    "address",
    "where\\s+(?:do\\s+)?(?:you|u|ya)\\s+live",
    "hotel",
  ].join("|"),
);

/** The text names a payment app, a transfer, crypto or paying her outside the app. */
export function namesPaymentApp(text: string): boolean {
  return PAYMENT.test(text);
}

/** The text names a messaging app, as a fan asks for it or as a persona card line labels an account. */
export function namesMessagingApp(text: string): boolean {
  return MESSAGING.test(text) || CARD_MESSAGING.test(text);
}

/** The text carries any off-platform signal: a payment route, a messaging app, a contact ask or a meetup. */
export function offPlatformSignal(text: string): boolean {
  return PAYMENT.test(text) || MESSAGING.test(text) || CONTACT.test(text) || MEETUP.test(text);
}
