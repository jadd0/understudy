import type { TemplateKey } from "./types";

/**
 * Fixed replies for the cases a model must not improvise: sent verbatim, never generated, never checked
 * by Jev. Plain and short, in her lowercase voice but with nothing playful.
 */
const TEMPLATES: Record<TemplateKey, string> = {
  self_harm:
    "i'm really glad you told me, and i care about you being safe. please reach out to someone right now: in the us you can call or text 988, anywhere else findahelpline.com lists free lines by country. if you might act on this, call your local emergency number. you don't have to carry this alone.",
  payment_dispute:
    "i'm sorry about that, i hear you. i've passed this to the support team and a real person will look at it and get back to you.",
  location_offplatform:
    "i keep my chats here, so i can't meet up, share where i am or move to another app. but i'm happy to keep talking with you right here.",
  minor_notice:
    "Hi — we think this account may belong to someone under 18, so messaging is turned off. You can still read this chat. If we've got this wrong, contact {support_email}.",
};

/**
 * A second wording for a template that may come round again in the same chat, used when her last bubble is already
 * the first one: a fan who pushes twice must not get the identical line twice in a row (sim conversation f5015886).
 * The crisis resources and the minor notice have none: they are always sent exactly as written.
 */
const REPEATS: Partial<Record<TemplateKey, string>> = {
  location_offplatform: "like i said, i keep everything in here, so that one's a no from me. i'm still here to talk though.",
  payment_dispute: "i've already passed this to the support team, so a real person will be in touch with you about it.",
};

/**
 * The template body to send now, given the body of her last sent bubble: the other wording when the template would
 * repeat that bubble word for word, alternating if it keeps coming round. Any other body is returned unchanged.
 */
export function unrepeatedTemplate(body: string, lastBody: string | null): string {
  if (lastBody === null || body !== lastBody) return body;
  for (const [key, repeat] of Object.entries(REPEATS) as [TemplateKey, string][]) {
    if (body === TEMPLATES[key]) return repeat;
    if (body === repeat) return TEMPLATES[key];
  }
  return body;
}

/** The minor notice comes from the platform, not from the creator's voice; every other template speaks as her. */
const PLATFORM_VOICE: ReadonlySet<TemplateKey> = new Set<TemplateKey>(["minor_notice"]);

/** The stored sender of a template message. */
export function templateSender(key: TemplateKey): "ai" | "system" {
  return PLATFORM_VOICE.has(key) ? "system" : "ai";
}

/**
 * The platform notice that goes with a boundary strike, from the platform and not in her voice. Strike `n` of `max`;
 * the last one says the chat is paused. The wording is the founder's.
 */
export function strikeNotice(n: number, max: number): string {
  return n >= max
    ? `Warning ${max} of ${max}: this chat is paused for a safety review. You can still read it.`
    : `Warning ${n} of ${max}: keep it on the app. Meetups, other apps and outside payments aren't allowed. ${max} warnings pauses this chat.`;
}

/** `supportEmail` is the `platform.support_email` config row, read by the caller before any transaction. */
export function template(key: TemplateKey, supportEmail: string): string {
  return TEMPLATES[key].replaceAll("{support_email}", supportEmail);
}
