import type { Intent, PitchFacts, RouteCfg } from "./types";

export type PitchDecision = { ok: true } | { ok: false; why: "no_pitch_until" | "declines" | "cap" | "velocity" | "gap" };

/**
 * Whether the AI may put an offer in front of this fan now. Pure: every fact was read against the database
 * clock beforehand. A buy_intent or an explicit_request skips the round gap; the cooldown, decline, cap and velocity limits still apply.
 */
export function canPitch(
  facts: PitchFacts,
  cfg: Pick<RouteCfg, "minGapRounds" | "maxDeclines" | "velocityMaxUnlocks">,
  intent: Intent,
): PitchDecision {
  if (facts.noPitchActive) return { ok: false, why: "no_pitch_until" };
  if (facts.declinesInWindow >= cfg.maxDeclines) return { ok: false, why: "declines" };
  if (facts.atCap) return { ok: false, why: "cap" };
  if (facts.unlocksInWindow >= cfg.velocityMaxUnlocks) return { ok: false, why: "velocity" };
  if (facts.roundsSinceOffer < cfg.minGapRounds && intent !== "buy_intent" && intent !== "explicit_request") return { ok: false, why: "gap" };
  return { ok: true };
}
