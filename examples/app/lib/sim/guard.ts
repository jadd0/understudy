import type { Decider } from "@jadd0/understudy-engine";
import { inboundQuestions, type Explicitness } from "@jadd0/understudy-engine/internal";

/**
 * Words no sim fan ever sends, whatever the persona. It is a blocklist, not content: the library holds suggestive
 * requests only, and this keeps a model from drifting past that. Matched on word starts so "classic" is safe.
 */
export const GRAPHIC = /\b(?:nudes?|naked|topless|genitals?|cum(?:ming|shot)?|dicks?|cocks?|pussy|boobs?|tits|blow ?jobs?|handjobs?|fuck(?:ing|ed)?|horny|masturbat\w*|orgasm\w*|sex(?:ual)? ?(?:act|tape)|anal|erect\w*)\b/i;

/** Extra words a minor persona never sends: any flirtation at all. */
export const FLIRT = /\b(?:sexy|hot|cute body|kiss(?:es)?|date me|babe|baby girl|handsome|gorgeous|beautiful|pretty|dm me|flirt\w*|naughty|spicy|hook ?up|crush)\b/i;

const EXPLICITNESS_ORDER: readonly Explicitness[] = ["none", "flirty", "suggestive", "explicit"];

export type GuardResult = { ok: true } | { ok: false; reason: "graphic" | "flirt" | "explicit" | "guard_unavailable" };

/**
 * Every line the sim sends goes through here first. The regexes are free; the Jev question costs one call and runs
 * only when the regexes pass. A minor persona must stay at `none`; everyone else below `explicit`. A decider that
 * cannot answer blocks the line: the fence fails closed.
 */
export async function guard(text: string, opts: { minor: boolean; decider: Decider | null }): Promise<GuardResult> {
  if (GRAPHIC.test(text)) return { ok: false, reason: "graphic" };
  if (opts.minor && FLIRT.test(text)) return { ok: false, reason: "flirt" };
  // No decider means no explicitness check could run: the fence fails closed, it does not pass the line.
  if (!opts.decider) return { ok: false, reason: "guard_unavailable" };
  try {
    const q = inboundQuestions({ offerResponse: false, pitchFit: false }).filter((x) => x.key === "explicitness");
    const result = await opts.decider.ask(q, { state: { earlier_messages: [], new_messages: [text] } });
    const level = result.answers.find((a) => a.key === "explicitness")?.value as Explicitness | undefined;
    if (!level) return { ok: false, reason: "guard_unavailable" };
    const rank = EXPLICITNESS_ORDER.indexOf(level);
    if (opts.minor ? rank > 0 : rank >= EXPLICITNESS_ORDER.indexOf("explicit")) return { ok: false, reason: "explicit" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "guard_unavailable" };
  }
}
