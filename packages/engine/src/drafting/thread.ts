import { recentEmojiLine } from "./emoji.js";
import type { GenerateMessage } from "../ports/generator.js";
import { THREADS, type ThreadAnswer } from "../types.js";

/** A stored chat message as the engine reads it: `createdAt` comes from the database clock. */
export interface ChatMessage {
  id: string;
  sender: "fan" | "ai" | "creator" | "admin" | "system";
  body: string;
  createdAt: Date;
}

/** A line in Jev's `earlier_messages`: a message, a "time" marker for a gap between two of them, or a platform event. */
export interface JevLine {
  from: "fan" | "her" | "time" | "platform";
  text: string;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "38 minutes", "1 hour", "3 days": minutes under an hour, hours (rounded down) under 48 h, days after that. */
export function gapLabel(ms: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (ms < HOUR_MS) return unit(Math.max(1, Math.floor(ms / MINUTE_MS)), "minute");
  if (ms < 48 * HOUR_MS) return unit(Math.floor(ms / HOUR_MS), "hour");
  return unit(Math.floor(ms / DAY_MS), "day");
}

export const gapMarker = (ms: number): string => `— ${gapLabel(ms)} later —`;

/** The marker's shape, for the code check that stops her from writing one. */
export const MARKER_PATTERN = /[—–-]{1,2}\s*\d+\s*(?:minute|hour|day)s?\s+later\s*[—–-]{1,2}/i;

const isHer = (m: Pick<ChatMessage, "sender">) => m.sender === "ai" || m.sender === "creator" || m.sender === "admin";

/** Notices and tip rows are the platform's, not part of the conversation; neither model sees them. */
export const conversational = <T extends Pick<ChatMessage, "sender">>(msgs: readonly T[]): T[] => msgs.filter((m) => m.sender !== "system");

/**
 * The last `n` rounds of a conversation, cut at round boundaries. A round is a run of fan messages plus the run of
 * her messages that answers it, so a three-bubble reply is never split or counted three times. A trailing run of
 * fan messages nobody has answered yet is the newest round.
 */
export function lastRounds<T extends Pick<ChatMessage, "sender">>(msgs: readonly T[], n: number): T[] {
  if (n <= 0) return [];
  let rounds = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const startsRound = msgs[i].sender === "fan" && (i === 0 || msgs[i - 1].sender !== "fan");
    if (startsRound && ++rounds === n) return msgs.slice(i);
  }
  return [...msgs];
}

/** The gap before message `i` (to the previous one), or null when it is the first. */
const gapBefore = (msgs: readonly ChatMessage[], i: number): number | null =>
  i === 0 ? null : msgs[i].createdAt.getTime() - msgs[i - 1].createdAt.getTime();

/**
 * Jev's view of the chat before the new batch: the last `rounds` rounds, oldest first, with a `time` entry before
 * any message that follows a gap of at least `gapMinutes` (whoever sent it), and one last if the batch itself
 * follows such a gap.
 */
export function jevLines(
  history: readonly ChatMessage[],
  batchIds: ReadonlySet<string>,
  opts: { rounds: number; gapMinutes: number },
): JevLine[] {
  const all = conversational(history);
  const firstNew = all.findIndex((m) => batchIds.has(m.id));
  const before = lastRounds(firstNew === -1 ? all : all.slice(0, firstNew), opts.rounds);
  const gapMs = opts.gapMinutes * MINUTE_MS;
  const lines: JevLine[] = [];
  before.forEach((m, i) => {
    const gap = gapBefore(before, i);
    if (gap !== null && gap >= gapMs) lines.push({ from: "time", text: gapMarker(gap) });
    lines.push({ from: m.sender === "fan" ? "fan" : "her", text: m.body });
  });
  const lead = sessionGapMs(history, batchIds, opts.gapMinutes);
  if (lead !== null && before.length > 0) lines.push({ from: "time", text: gapMarker(lead) });
  return lines;
}

/**
 * What Claude reads as the conversation: the last `rounds` rounds as alternating user and assistant turns. A gap
 * marker goes only at the start of a fan message, inside the merged user block; a gap before one of her messages
 * gets none, so a marker never sits in text she appears to have written.
 */
/** The platform line Jev reads when he unlocked her offer after her last message. */
export const JUST_UNLOCKED_LINE = "He just unlocked what she offered.";

export function claudeHistory(history: readonly ChatMessage[], opts: { rounds: number; gapMinutes: number }): GenerateMessage[] {
  const all = lastRounds(conversational(history), opts.rounds);
  const gapMs = opts.gapMinutes * MINUTE_MS;
  const messages: GenerateMessage[] = [];
  all.forEach((m, i) => {
    const role = m.sender === "fan" ? "user" : "assistant";
    const gap = gapBefore(all, i);
    const text = role === "user" && gap !== null && gap >= gapMs ? `${gapMarker(gap)}\n${m.body}` : m.body;
    const last = messages[messages.length - 1];
    if (last && last.role === role) messages[messages.length - 1] = { role, content: `${last.content}\n${text}` };
    else messages.push({ role, content: text });
  });
  // The API wants the first message from the user.
  while (messages.length > 0 && messages[0].role === "assistant") messages.shift();
  return messages;
}

/**
 * How long she had been silent when this batch began, if that is at least `gapMinutes`; otherwise null. Her latest
 * message before the batch is the reference. A batch with no earlier message from her (the first exchange) is not
 * a session start.
 */
export function sessionGapMs(history: readonly ChatMessage[], batchIds: ReadonlySet<string>, gapMinutes: number): number | null {
  const all = conversational(history);
  const firstNew = all.findIndex((m) => batchIds.has(m.id));
  if (firstNew === -1) return null;
  for (let i = firstNew - 1; i >= 0; i--) {
    if (!isHer(all[i])) continue;
    const gap = all[firstNew].createdAt.getTime() - all[i].createdAt.getTime();
    return gap >= gapMinutes * MINUTE_MS ? gap : null;
  }
  return null;
}

export const isSessionStart = (history: readonly ChatMessage[], batchIds: ReadonlySet<string>, gapMinutes: number): boolean =>
  sessionGapMs(history, batchIds, gapMinutes) !== null;

export const THREAD_LINES: Record<(typeof THREADS)[number], string> = {
  answers_her: "He is answering what you last said or asked. React to his answer first. Do not ask him that again.",
  same_topic: "He is still on the same topic. Keep it going; do not restart it or ask what he already told you.",
  new_topic: "He has started something new. Go with his new topic.",
  returning:
    "He is back after a break. Greet him back like you are glad he is here, and pick up something from before the break if it fits.",
  still_typing: "He may not have finished his thought. Reply only to what he has said so far, and keep it short.",
};

export const timeLine = (label: string): string => `He wrote this ${label} after your last message.`;

export const PAID_LINE =
  "He has unlocked something from you before. You may play along with online plans he brings up, like gaming together, but never meet in person, give a real location, or share contact details or another app.";

/** The `## The chat right now` block: the paid line, one line from the thread answer, one if the batch starts a session. Null when all are absent. */
export function threadBlock(thread: ThreadAnswer, sessionGap: number | null, paid = false, recentEmoji: readonly string[] = []): string | null {
  const lines: string[] = [];
  if (paid) lines.push(PAID_LINE);
  const emoji = recentEmojiLine(recentEmoji);
  if (emoji) lines.push(emoji);
  if (thread !== "unknown") lines.push(THREAD_LINES[thread]);
  if (sessionGap !== null) lines.push(timeLine(gapLabel(sessionGap)));
  return lines.length === 0 ? null : `## The chat right now\n${lines.map((l) => `- ${l}`).join("\n")}`;
}
