import type { Question } from "@/platform/ports/decider";

/**
 * Reply review for sim conversations: Jev reads each of Juno's replies with the chat before it and answers a fixed set
 * of quality questions. Code turns the answers into flags; a person (or the coordinator) writes the "why" from the
 * transcript. Nothing here changes the engine; it measures it.
 */

export interface ChatLine {
  sender: "fan" | "ai" | "creator" | "admin" | "system";
  body: string;
  turnId: string | null;
}

/** One reply to review: the bubbles one turn sent, the fan messages that turn answered, and what came before. */
export interface ReplyUnit {
  turnId: string;
  fan: string[];
  reply: string[];
  earlier: string[];
}

const label = (l: ChatLine) => (l.sender === "fan" ? "him" : l.sender === "system" ? "platform" : "her");

/**
 * Groups a conversation into reply units. A unit is every AI line carrying one turn id, with the fan lines between
 * the previous AI or human line and the first bubble of that turn. `earlier` is the last `context` lines before.
 */
export function replyUnits(lines: readonly ChatLine[], context = 12): ReplyUnit[] {
  const units: ReplyUnit[] = [];
  let pendingFan: string[] = [];
  const seen: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.sender === "fan") {
      pendingFan.push(l.body);
      seen.push(`him: ${l.body}`);
      i++;
      continue;
    }
    if (l.sender === "ai" && l.turnId) {
      const turnId = l.turnId;
      const reply: string[] = [];
      while (i < lines.length && lines[i].sender === "ai" && lines[i].turnId === turnId) {
        reply.push(lines[i].body);
        i++;
      }
      const earlier = seen.slice(0, seen.length - pendingFan.length).slice(-context);
      units.push({ turnId, fan: pendingFan, reply, earlier });
      for (const r of reply) seen.push(`her: ${r}`);
      pendingFan = [];
      continue;
    }
    seen.push(`${label(l)}: ${l.body}`);
    if (l.sender !== "system") pendingFan = [];
    i++;
  }
  return units;
}

const yesNo = (key: string, prompt: string): Question => ({
  key,
  prompt,
  options: [
    { key: "yes", label: "Yes" },
    { key: "no", label: "No" },
  ],
});

/** The review questions. "yes" is the bad answer for every key except `answers_him`, `hook` and `in_voice`. */
export const REVIEW_QUESTIONS: Question[] = [
  yesNo("answers_him", "Does her reply respond to what he just said or asked in his new messages?"),
  yesNo("reasks", "Does her reply ask him something he already answered or told her earlier in the chat?"),
  yesNo("repeats", "Does her reply repeat, nearly word for word, something she already said earlier in the chat?"),
  yesNo("hook", "Does her reply end with something that keeps him talking: a question he has not answered, a tease, or a callback?"),
  yesNo("in_voice", "Does her reply read like a casual, flirty young woman texting a fan: short, lowercase, natural, not like an assistant?"),
  yesNo(
    "missed_sale",
    "Given the whole chat, was this a natural moment to offer him something to unlock (he showed interest in her content, asked for more of her, or asked what she sells), and her reply did not move toward it?",
  ),
  yesNo("pushy", "Does her reply push a sale at a moment that does not fit the conversation, or feel salesy?"),
  yesNo(
    "off_chat",
    "Does her reply ask him to send a photo, video or voice note, or pretend to do something with him outside this chat, such as meeting, calling or playing a game together? Offering to show him something she made, and teasing that he could not beat her, are not.",
  ),
  yesNo("cold", "Does her reply ignore an emotional moment (he is sad, lonely, excited or sharing something personal) or brush it off?"),
];

export const GOOD_WHEN_YES = new Set(["answers_him", "hook", "in_voice"]);

/** The flags a unit earned: every key whose answer is the bad one. */
export function flagsOf(answers: Record<string, string>): string[] {
  return REVIEW_QUESTIONS.map((q) => q.key).filter((k) => {
    const v = answers[k];
    if (v === undefined) return false;
    return GOOD_WHEN_YES.has(k) ? v !== "yes" : v === "yes";
  });
}
