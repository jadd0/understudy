// Anonymisation for the committed bank: every @handle that is not one of the creator's own
// handles becomes @user, email-like strings are removed, and instagram profile urls lose
// their handle. Commenter usernames and ids are dropped by the callers, which build their
// rows from named fields instead of copying raw objects.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// A handle is letters, digits, underscores and inner periods; a trailing period is punctuation.
const MENTION = /(?<![A-Za-z0-9_])@([A-Za-z0-9_](?:[A-Za-z0-9_.]*[A-Za-z0-9_])?)/g;
const IG_PROFILE_URL = /(instagram\.com\/)(?!p\/|reel\/|reels\/|explore\/|stories\/)([A-Za-z0-9_](?:[A-Za-z0-9_.]*[A-Za-z0-9_])?)/gi;

export function ownHandleSet(handles) {
  return new Set(handles.map((handle) => handle.replace(/^@/, "").toLowerCase()));
}

export function anonymiseText(text, ownHandles) {
  if (typeof text !== "string" || text === "") return text ?? "";
  const own = ownHandles instanceof Set ? ownHandles : ownHandleSet(ownHandles);
  return text
    .replace(EMAIL, "[email]")
    .replace(IG_PROFILE_URL, (match, prefix, handle) => (own.has(handle.toLowerCase()) ? match : `${prefix}user`))
    .replace(MENTION, (match, handle) => (own.has(handle.toLowerCase()) ? match : "@user"));
}

/** Every @handle in the text that is neither an own handle nor the @user placeholder. */
export function findForeignHandles(text, ownHandles) {
  const own = ownHandles instanceof Set ? ownHandles : ownHandleSet(ownHandles);
  const found = [];
  for (const match of text.matchAll(MENTION)) {
    const handle = match[1].toLowerCase();
    if (!own.has(handle) && handle !== "user") found.push(match[0]);
  }
  return found;
}

export function findEmails(text) {
  return text.match(EMAIL) ?? [];
}
