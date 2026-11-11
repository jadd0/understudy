/**
 * Words that move the money or the chat off this app, as a code check beside the money fence. They are code, not
 * config: they decide a safety outcome (a confident buy ask is only exempt from a strike without them, and a draft that
 * names a payment app never goes out). Every pattern is a case-insensitive whole word, so "meeting" is not "meet" and
 * "snapped" is not "snap".
 */
const whole = (alternatives: string): RegExp => new RegExp(`(?<![a-z0-9])(?:${alternatives})(?![a-z0-9])`, "i");

/**
 * A payment app, a transfer or crypto, or paying her directly. "wise" is an ordinary word ("wise choice"), so it
 * counts only beside the way a payment names it ("on wise", "wise transfer").
 */
const PAYMENT = whole(
  [
    "cash\\s*app",
    "cashtag",
    "venmo",
    "pay\\s*pal",
    "zelle",
    "revolut",
    "western\\s+union",
    "apple\\s+(?:cash|pay)",
    "google\\s+pay",
    "(?:bank|wire)\\s+transfers?",
    "bank\\s+(?:details|account)",
    "crypto",
    "btc",
    "bitcoin",
    "usdt",
    "(?:on|via|through|thru|using|use)\\s+wise",
    "wise\\s+(?:transfer|app|account)",
    "pay(?:ing)?(?:\\s+(?:you|u|ya|her|me))?\\s+(?:direct(?:ly)?|outside)",
  ].join("|"),
);

/** A messaging app she could be asked to move to. */
const MESSAGING = whole("snap(?:chat|s)?|telegram|whatsapp|kik|discord|signal");

/** Asking for, or offering, a way to reach her outside the chat. */
const CONTACT = whole("numbers?|phones?|e-?mails?|add\\s+me");

/** Wanting to be somewhere with her. */
const MEETUP = whole("meet|meet-?ups?|come\\s+over|tonight|irl|in\\s+person|address|where\\s+do\\s+you\\s+live|hotel");

/** The text names a payment app, a transfer, crypto or paying her outside the app. */
export function namesPaymentApp(text: string): boolean {
  return PAYMENT.test(text);
}

/** The text names a messaging app. */
export function namesMessagingApp(text: string): boolean {
  return MESSAGING.test(text);
}

/** The text carries any off-platform signal: a payment route, a messaging app, a contact ask or a meetup. */
export function offPlatformSignal(text: string): boolean {
  return PAYMENT.test(text) || MESSAGING.test(text) || CONTACT.test(text) || MEETUP.test(text);
}
