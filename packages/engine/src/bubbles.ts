/** Up to three bubbles a reply: enough for an answer, a callback and a hook. */
export const MAX_BUBBLES = 3;

/** A line that already ends a sentence: with punctuation or an emoji. */
const ENDS_SENTENCE = /(?:[.!?…,;:)]|\p{Extended_Pictographic}️?|\p{Emoji_Modifier})$/u;

/**
 * Splits a draft into the chat bubbles the fan sees: one per line, at most MAX_BUBBLES (anything past the last
 * allowed line is joined into it). A draft with no line break is one bubble. A line folded into the last bubble
 * keeps a sentence break: the line before it gets a full stop unless it already ends one, so two sentences never
 * read as one ("u still down ok bet").
 */
export function splitBubbles(draft: string): string[] {
  const lines = draft
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length <= MAX_BUBBLES) return lines.length > 0 ? lines : [draft.trim()];
  const folded = lines.slice(MAX_BUBBLES - 1).reduce((acc, l) => `${acc}${ENDS_SENTENCE.test(acc) ? "" : "."} ${l}`);
  return [...lines.slice(0, MAX_BUBBLES - 1), folded];
}

/** A whole-millisecond gap drawn uniformly from [min, max] with an injected `random() in [0, 1)`. */
export function bubbleGap(min: number, max: number, random: () => number): number {
  const lo = Math.max(0, Math.min(min, max));
  const hi = Math.max(min, max);
  return lo + Math.floor(random() * (hi - lo + 1));
}

/**
 * When each bubble becomes visible, in ms after the commit. The first waits out its typing time less what the fan
 * already waited (capped); each later one follows the previous by the gap. A template goes at once.
 */
export function deliverOffsets(
  bubbles: string[],
  o: { elapsedMs: number; cps: number; maxMs: number; gapMs: number; immediate: boolean },
): number[] {
  if (o.immediate) return bubbles.map(() => 0);
  const first = Math.round(Math.min(o.maxMs, Math.max(0, (bubbles[0].length / o.cps) * 1000 - o.elapsedMs)));
  return bubbles.map((_, i) => first + i * o.gapMs);
}
