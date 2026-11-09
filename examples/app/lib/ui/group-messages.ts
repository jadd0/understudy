/**
 * Turns a flat message list into render rows the way the chat design groups them:
 * consecutive messages from one side form a run; the run's first and last bubbles get the full
 * radius on the joined side, only the last "them" bubble shows the avatar, and a gap of
 * `separatorGapMinutes` or a new day inserts a time separator. A "them" message from Understudy support (an admin
 * writing to the fan) is a different speaker from the creator: it starts its own run, carries a label and never the
 * creator's avatar.
 */
export type Side = "me" | "them" | "system";

export interface ChatMessageInput {
  readonly id: string;
  readonly side: Side;
  readonly text: string;
  readonly at: Date;
  /** Set on a system row that records a tip: the amount as shown ("$5.00"). Drawn as a tip card. */
  readonly tip?: string;
  /** Set on a "them" message written by Understudy support rather than the creator. */
  readonly support?: boolean;
}

export type ChatRow =
  | { readonly kind: "separator"; readonly key: string; readonly label: string }
  | {
      readonly kind: "message";
      readonly key: string;
      readonly side: Side;
      readonly text: string;
      /** Clock time shown on hover beside the bubble. */
      readonly time: string;
      readonly tip?: string;
      /** A Understudy support message: labelled on its first bubble, no creator avatar. */
      readonly support: boolean;
      readonly first: boolean;
      readonly last: boolean;
      readonly showAvatar: boolean;
    };

export function clockTime(at: Date): string {
  return at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export function separatorLabel(at: Date, now: Date): string {
  const time = clockTime(at);
  const sameDay = at.toDateString() === now.toDateString();
  if (sameDay) return `Today ${time}`;
  const day = at.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return `${day} ${time}`;
}

export function groupMessages(
  messages: readonly ChatMessageInput[],
  now: Date,
  separatorGapMinutes = 30,
): ChatRow[] {
  const rows: ChatRow[] = [];
  const gapMs = separatorGapMinutes * 60_000;
  // A separator splits runs, so compute run boundaries after deciding separators.
  const breaks = messages.map((m, i) => {
    const prev = messages[i - 1];
    return !prev || m.at.getTime() - prev.at.getTime() >= gapMs || m.at.toDateString() !== prev.at.toDateString();
  });
  messages.forEach((m, i) => {
    if (breaks[i]) {
      // Within a day the first separator names the day; the later ones are just the time, as drawn.
      const earlier = messages.slice(0, i).filter((_, j) => breaks[j]).at(-1);
      const label =
        earlier && earlier.at.toDateString() === m.at.toDateString() ? clockTime(m.at) : separatorLabel(m.at, now);
      rows.push({ kind: "separator", key: `sep-${m.id}`, label });
    }
    const prev = messages[i - 1];
    const next = messages[i + 1];
    const support = m.support === true;
    const sameSpeaker = (o: ChatMessageInput) => o.side === m.side && (o.support === true) === support && m.side !== "system";
    const samePrev = !!prev && !breaks[i] && sameSpeaker(prev);
    const sameNext = !!next && !breaks[i + 1] && sameSpeaker(next);
    rows.push({
      kind: "message",
      key: m.id,
      side: m.side,
      text: m.text,
      time: clockTime(m.at),
      tip: m.tip,
      support,
      first: !samePrev,
      last: !sameNext,
      showAvatar: m.side === "them" && !support && !sameNext,
    });
  });
  return rows;
}
