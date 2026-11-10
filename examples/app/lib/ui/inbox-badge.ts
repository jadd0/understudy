/** The status chip on an inbox row. Pure, so the rules are tested without a database. */
export type InboxMode = "ai" | "handoff_creator" | "human_creator" | "handoff_ts" | "human_ts" | "closed";
export type InboxFilter = "all" | "needs" | "ai";

export interface BadgeInput {
  mode: InboxMode;
  aiEnabled: boolean;
  /** An unresolved creator-queue handoff (an alert counts: the AI keeps replying but the creator should look). */
  openCreatorHandoff: boolean;
  viewer: "creator" | "admin";
  /** The conversation's creator, named to an admin who sees every creator's chats. */
  creatorName: string;
}

export function inboxBadge(i: BadgeInput): string | null {
  // An admin sees every conversation: T&S ones are marked, the rest show who is answering.
  if (i.viewer === "admin" && (i.mode === "handoff_ts" || i.mode === "human_ts")) return "T&S";
  if (i.mode === "human_creator") return i.viewer === "admin" ? i.creatorName : "You";
  if (i.openCreatorHandoff || i.mode === "handoff_creator") return "Handoff";
  if (i.mode === "ai") return i.aiEnabled ? "AI" : "AI off";
  return null;
}

/** "Needs you" is everything waiting on the creator; "AI" is what the AI is currently answering. */
export function matchesFilter(badge: string | null, filter: InboxFilter): boolean {
  if (filter === "all") return true;
  if (filter === "needs") return badge === "Handoff";
  return badge === "AI";
}

/** Compact relative time for a list row ("now", "5m", "3h", "2d"). */
export function shortAge(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

export interface DueInput {
  queue: "creator" | "ts";
  /** Milliseconds until the handoff's due time (negative once late); null when it has none. */
  dueInMs: number | null;
  /** Milliseconds since the handoff opened. */
  openedAgoMs: number;
  /** The sweep settles this reason by policy once it is due. */
  autoResolves: boolean;
  /** A Trust & Safety handoff that has passed its due time. */
  breached: boolean;
}

/**
 * The line under a queue row about its due time: when a creator-queue handoff will settle itself, or how long a
 * Trust & Safety one has waited. Null when there is nothing to say (no due time, or a reason a person must handle).
 */
export function dueNote(i: DueInput): string | null {
  if (i.queue === "ts") return `Waiting ${shortAge(i.openedAgoMs)}${i.breached ? " · late" : ""}`;
  if (!i.autoResolves || i.dueInMs === null) return null;
  if (i.dueInMs <= 0) return "Auto-resolving now";
  return `Auto-resolves in ${Math.max(1, Math.ceil(i.dueInMs / 60_000))} min`;
}
