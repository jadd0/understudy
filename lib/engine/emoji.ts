import type { ChatMessage } from "./thread";

/**
 * Emoji variety. Left alone the model leans on the same two or three emoji and copies them from its own earlier
 * bubbles (sim batch: 18 of 22 emoji were 🙈 or 😏, against about a third in her real replies). The turn names the
 * emoji she used in her last few bubbles so the draft picks another, and `dropRepeatedEmoji` removes any it repeats.
 */

/** One emoji as written: a pictograph plus any variation selector, skin tone or zero-width-joined parts. */
const EMOJI = /\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)*/gu;

/** Bubbles of hers that count as "recent" for variety. */
export const RECENT_BUBBLES = 8;

export function emojiIn(text: string): string[] {
  return text.match(EMOJI) ?? [];
}

/** The distinct emoji in her last `n` bubbles (AI or creator), newest first. */
export function recentEmoji(history: readonly Pick<ChatMessage, "sender" | "body">[], n = RECENT_BUBBLES): string[] {
  const hers = history.filter((m) => m.sender === "ai" || m.sender === "creator").slice(-n);
  return [...new Set(hers.reverse().flatMap((m) => emojiIn(m.body)))];
}

/**
 * The draft without any emoji in `recent`, tidying the space it leaves. Other emoji stay; a draft that would be left
 * empty is kept whole. She often ends a sentence with an emoji instead of a full stop ("not her in person 🙈 still
 * happy"), so a removed emoji with text on both sides becomes a line break, and each sentence stays its own bubble
 *. Deleting it outright glued the two sentences into one ("not her in person still happy").
 */
export function dropRepeatedEmoji(draft: string, recent: readonly string[]): string {
  if (recent.length === 0) return draft;
  const banned = new Set(recent);
  const out = draft
    .split("\n")
    .flatMap((line) =>
      line
        .replace(EMOJI, (e, at: number, whole: string) => {
          if (!banned.has(e)) return e;
          const before = whole.slice(0, at).trim();
          const after = whole.slice(at + e.length).trim();
          return before && after && /^[\p{L}\p{N}]/u.test(after) ? "\n" : "";
        })
        .split("\n"),
    )
    .map((line) => line.replace(/[ \t]{2,}/g, " ").replace(/ ([,.!?])/g, "$1").trim())
    .filter((line) => line.length > 0)
    .join("\n");
  return out.length > 0 ? out : draft;
}

/** The prompt line naming them. */
export function recentEmojiLine(recent: readonly string[]): string | null {
  return recent.length === 0 ? null : `You used ${recent.join(" ")} in your last messages to him. Do not use those again now: pick a different emoji or none.`;
}
