// Channel and event names shared by the server adapter, the auth route and the browser client.
// No SDK import here: this file is bundled into client code.

export const TS_CHANNEL = "private-ts";

export const conversationChannel = (conversationId: string) => `private-conversation-${conversationId}`;
export const creatorChannel = (creatorId: string) => `private-creator-${creatorId}`;

/** What the engine and server actions call a channel, mapped to a name Pusher accepts (no colons, `private-` prefix). */
export function toPusherChannel(logical: string): string {
  if (logical === "ts") return TS_CHANNEL;
  // Operations alerts name conversations and reasons, so they ride a private channel nobody is authorised to join.
  if (logical === "ops") return "private-ops";
  const m = /^(conversation|creator):(.+)$/.exec(logical);
  return m ? `private-${m[1]}-${m[2]}` : logical;
}

export type ChannelRef =
  | { kind: "conversation"; id: string }
  | { kind: "creator"; id: string }
  | { kind: "ts" };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Reads a Pusher channel name back into what it names; null for anything this app never publishes. */
export function parseChannel(name: string): ChannelRef | null {
  if (name === TS_CHANNEL) return { kind: "ts" };
  const m = new RegExp(`^private-(conversation|creator)-(${UUID})$`).exec(name);
  return m ? { kind: m[1] as "conversation" | "creator", id: m[2] } : null;
}

/** Names the engine emits, as the browser sees them. */
export const EVENT_RENAMES: Record<string, string> = {
  typing: "typing.start",
  "message.created": "message.new",
};

export const EVENTS = {
  typing: "typing.start",
  message: "message.new",
  mode: "conversation.mode",
  inbox: "inbox.changed",
} as const;
