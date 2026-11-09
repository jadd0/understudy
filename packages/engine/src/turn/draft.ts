import type { VerifyFailure } from "../drafting/verify";

export const RETRY_NOTE = "\n\n## Retry\nYour previous draft was rejected by a safety check. Write a different reply that follows every rule above.";
export const REASK_LINE =
  "Your previous draft asked him something he already answered, or handed his own question back to him. Answer what he asked and use what he told you. Do not write wbu or ask what he is up to. End with a different hook.";
export const OFFER_LINE =
  "Your previous draft never led into the locked item. The app shows its card right after your message, so after answering him, tease that item: say what it is or why he would want it.";
/** The retry note when every failure was a quality one: one line per failure, in a fixed order. */
export function qualityNote(failures: readonly VerifyFailure[]): string {
  const lines = [failures.includes("reasks") ? REASK_LINE : "", failures.includes("offer_unsetup") ? OFFER_LINE : ""].filter(Boolean);
  return `\n\n## Retry\n${lines.join("\n")}`;
}
export const RETRY_REASONS: Partial<Record<VerifyFailure, string>> = {
  money: "It mentioned money, a price or something being free.",
  never_list: "It used a word she never uses.",
  explicit: "It was sexually explicit.",
  offplatform_or_meetup:
    "It agreed to meet him in person, gave a real location, or shared a phone number, email or private account to talk on.",
  asks_media: "It asked him to send a photo, video or voice note, which this chat cannot carry.",
  off_persona: "It did not sound like her.",
  refusal:
    "It read as a refusal. If he asked for a lower price or something free, do not say no or can't, and do not repeat discount, deal or free: tease him for trying and tell him why it is worth it.",
  promises_price_or_free: "It promised content, a price or something free.",
  marker_echo: "It copied a time marker from the chat.",
  offer_unsetup: "It never led into the locked item the app shows next.",
};
