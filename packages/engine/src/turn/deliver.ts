import type { Events } from "../ports/events.js";
import type { CommitResult } from "./plan.js";
import { describeError } from "./result.js";

/** Tells the fan's channel about the messages a commit stored for delivery; a failed emit is logged, never thrown. */
export async function emitDelivery(events: Events, conversationId: string, result: Pick<CommitResult, "messageIds" | "deliverInMs">) {
  if (result.messageIds.length === 0) return;
  const channel = `conversation:${conversationId}`;
  const holdMs = Math.max(...result.deliverInMs);
  // The typing indicator stays on until the last bubble is due.
  const sends = [
    events.emit(channel, "typing", { holdMs }),
    ...result.messageIds.map((messageId, i) => events.emit(channel, "message.created", { messageId, deliverInMs: result.deliverInMs[i] })),
  ];
  await Promise.all(sends).catch((e) => console.error(`engine: emit failed ${describeError(e)}`));
}
