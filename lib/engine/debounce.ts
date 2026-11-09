/** The fan's unanswered messages and whether his composer says he is typing, as of one read. */
export interface InboundState {
  ids: string[];
  typing: boolean;
}

export interface WaitDeps {
  load: () => Promise<InboundState>;
  sleep: (ms: number) => Promise<void>;
}

export interface WaitOpts {
  /** Wait after his last message; 0 or less turns waiting off (one load, no sleep). */
  debounceMs: number;
  /** Total sleep a turn may spend waiting on him. */
  maxMs: number;
}

export interface WaitStats {
  waitedMs: number;
  passes: number;
}

const grew = (before: InboundState, after: InboundState) => after.ids.some((id) => !before.ids.includes(id));

/**
 * Waits until he has been quiet for `debounceMs` and is not typing. A message that arrives during a wait, or a
 * composer ping that says he is typing, starts another wait; the sum of all sleeps never passes `maxMs`, so a fan
 * who keeps typing cannot hold the turn. Returns the last state read, with the stats updated in place.
 */
export async function waitForQuiet(deps: WaitDeps, opts: WaitOpts, stats: WaitStats): Promise<InboundState> {
  let state = await deps.load();
  if (state.ids.length === 0 || opts.debounceMs <= 0) return state;
  while (stats.waitedMs < opts.maxMs) {
    const step = Math.min(opts.debounceMs, opts.maxMs - stats.waitedMs);
    await deps.sleep(step);
    stats.waitedMs += step;
    stats.passes++;
    const next = await deps.load();
    const moved = grew(state, next);
    state = next;
    if (!moved && !next.typing) break;
  }
  return state;
}

/**
 * For a batch that Jev says stops mid-thought: waits for another message, one `debounceMs` at a time, while
 * `canStart` allows and the total stays under `maxMs`. Returns the new state when the batch grew, null when it did not.
 */
export async function waitForMore(
  deps: WaitDeps,
  opts: WaitOpts & { canStart: () => boolean },
  stats: WaitStats,
  current: InboundState,
): Promise<InboundState | null> {
  if (opts.debounceMs <= 0) return null;
  while (stats.waitedMs < opts.maxMs && opts.canStart()) {
    const step = Math.min(opts.debounceMs, opts.maxMs - stats.waitedMs);
    await deps.sleep(step);
    stats.waitedMs += step;
    stats.passes++;
    const next = await deps.load();
    if (grew(current, next)) return next;
  }
  return null;
}
