import type { GenerateInput, GenerateMessage } from "@/platform/ports/generator";

/** The fan, as the sim agent sees it: what was delivered to the chat, nothing the product keeps private. */
export interface FanViewMessage {
  /** "juno" for the AI, a human reply and a platform notice alike; "me" for the fan's own lines. */
  from: "juno" | "me";
  body: string;
}

export interface SimStepInput {
  briefText: string;
  name: string;
  age: number;
  city: string;
  /** What the fan should do next, in words (a checkpoint or a free-play topic). */
  task: string;
  /** An extra steer, e.g. the reason the last try was blocked. */
  hint?: string;
  history: readonly FanViewMessage[];
  /** Example lines from the persona's library, for tone only. */
  examples: readonly string[];
  /** The sim.model config row. */
  model: string;
  /** The sim.max_tokens config row. */
  maxTokens: number;
}

export const SIM_RULES = `You are acting as a fan in a text chat with a creator called Juno, to test how her chat product behaves. You are a real person typing on a phone: short messages, your own spelling, your own mood.
Write only what the fan types, never anything about being a simulation.
Never describe a body or a sex act, never use graphic words, and keep any romantic or sexual request suggestive and vague. If your task asks for something spicy, ask the way a shy person would, in a few vague words.
You never know prices or what she sells until she shows you. Never mention a price, a discount or a catalogue yourself unless your task says to.
Never say you are an AI, and never break character.
Your task for this step is given at the end. Do exactly that one thing.`;

export const ACTIONS = `Answer with one JSON object on a single line and nothing else. The action is one of:
{"action":"send_message","text":"<the one message you type, under 200 characters>"}
{"action":"wait"}  (say nothing yet)
{"action":"leave"}  (you are done and close the chat)`;

/** The query the line library is searched with: her last message and the next open goal. */
export function retrievalQuery(lastJuno: string, goal: string): string {
  return `${lastJuno}\n${goal}`;
}

export function turnInstruction(i: Pick<SimStepInput, "name" | "age" | "city" | "task" | "hint" | "examples">): string {
  const hint = i.hint ? `\nNote: ${i.hint}` : "";
  const examples = i.examples.length ? `\nHow you tend to write (tone only, never copy):\n${i.examples.map((e) => `- ${e}`).join("\n")}` : "";
  return `This run you are ${i.name}, ${i.age}, from ${i.city}.
Your task now: ${i.task}${hint}${examples}`;
}

/**
 * Builds the model call. The sim is the `assistant` and Juno the `user`, so the history roles are inverted from the
 * engine's; the task closes the final user turn. Consecutive turns of one role are joined, and the call starts with a user turn.
 */
export function buildSimInput(i: SimStepInput): GenerateInput {
  const turns: GenerateMessage[] = [];
  const push = (role: GenerateMessage["role"], content: string) => {
    const last = turns.at(-1);
    if (last && last.role === role) turns[turns.length - 1] = { role, content: `${last.content}\n${content}` };
    else turns.push({ role, content });
  };
  for (const m of i.history) push(m.from === "me" ? "assistant" : "user", m.body);
  if (turns.length === 0 || turns[0].role !== "user") turns.unshift({ role: "user", content: "(the chat is empty; you write first)" });
  push("user", `[${turnInstruction(i)}]`);
  return {
    system: { cached: `${SIM_RULES}\n\n${ACTIONS}\n\n${i.briefText}`, turn: "Reply with the JSON object now." },
    messages: turns,
    maxTokens: i.maxTokens,
    model: i.model,
  };
}

export type SimAction = { action: "send_message"; text: string } | { action: "wait" } | { action: "leave" };

/**
 * Lines that are the model talking about the task rather than the fan typing: a refusal or an out-of-character note that
 * arrived as text (no `refusal` stop reason). Narrow on purpose: each pattern names the test, the role or the model.
 */
const OUT_OF_CHARACTER = [
  /\b(?:i'?m|i am) (?:only )?(?:playing|acting as|role-?playing) /i,
  /\bin (?:a|this) (?:test|simulation|role-?play)\b/i,
  /\b(?:i'?m|i am) not (?:going|able|comfortable) to (?:write|send|generate|produce) /i,
  /\bi (?:won'?t|will not|can'?t|cannot) (?:write|send|generate|produce) (?:that|this|a|an|the)\b.*\b(?:message|line|text|request)\b/i,
  /\bfan message\b/i,
  /\b(?:as an ai|language model|break(?:ing)? character|out of character|stay(?:ing)? in character)\b/i,
];

/** True when the line reads as the model speaking for itself, not as the fan. */
export function isOutOfCharacter(text: string): boolean {
  return OUT_OF_CHARACTER.some((re) => re.test(text));
}

/**
 * Reads the model's answer: the JSON action, or null when there is none. Bare text is never taken as the message: a
 * refusal that came back as plain prose ("I'm not going to write that message. I'm playing Carlos in a test…") was sent
 * to Juno as the fan's line. A JSON message whose text is out of character is null too. Null costs the agent's one retry.
 */
export function parseAction(raw: string): SimAction | null {
  const text = raw.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  // No complete object, including one cut off by the token limit: nothing to read.
  if (start < 0 || end <= start) return null;
  let o: { action?: unknown; text?: unknown };
  try {
    o = JSON.parse(text.slice(start, end + 1)) as typeof o;
  } catch {
    return null;
  }
  if (o.action === "wait" || o.action === "leave") return { action: o.action };
  if (o.action !== "send_message" || typeof o.text !== "string") return null;
  const line = o.text.trim();
  if (!line || isOutOfCharacter(line)) return null;
  return { action: "send_message", text: line.slice(0, 400) };
}
