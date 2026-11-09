/**
 * How long after the fan sends before her typing row may appear. A client display delay only: the engine's
 * own timing (debounce, typing time) is config and is not changed by this.
 */
export const TYPING_AFTER_SEND_MS = 500;

/** Milliseconds left before the typing row may show for a send made at `sentAt`; 0 once it may (or with no send). */
export function typingHoldMs(sentAt: number | null, now: number, delayMs: number = TYPING_AFTER_SEND_MS): number {
  if (sentAt === null) return 0;
  return Math.max(0, sentAt + delayMs - now);
}

