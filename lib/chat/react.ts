import { after } from "next/server";
import { db } from "@/db/client";
import { messages } from "@/db/schema";
import { defaultDeps } from "@/lib/host/deps";
import { TIP_ROW_PREFIX, processConversation } from "@understudy/engine";
import { formatCents } from "@/lib/wallet/money";
import { tip } from "@/lib/wallet/tip";
import { unlockOffer, type UnlockResult } from "@/lib/wallet/unlock";

type Schedule = (task: () => Promise<unknown>) => void;
const afterResponse: Schedule = (task) => after(task);

/** Runs the engine on the conversation after the response, as a fan message does: she reacts to the tip or unlock. */
function scheduleTurn(conversationId: string, schedule: Schedule) {
  schedule(async () => processConversation(conversationId, await defaultDeps()));
}

export interface ChatTipResult {
  /** The system row's id when this call wrote it; null on a retry, which charges, posts and schedules nothing. */
  messageId: string | null;
}

/**
 * Tips the creator inside the fan's conversation and leaves a system row ("You tipped $5.00") both sides see, then
 * schedules a turn in which she thanks him in her own voice; the engine never sees the row's amount. The
 * idempotency key is scoped to the fan by the ledger and also keys the row, so a retry charges, posts and thanks once.
 * `fanId` must come from the session.
 */
export async function tipInChat(
  fanId: string,
  creatorId: string,
  conversationId: string,
  amountCents: number,
  idempotencyKey: string,
  schedule: Schedule = afterResponse,
): Promise<ChatTipResult> {
  await tip(fanId, creatorId, amountCents, idempotencyKey, conversationId);
  const [row] = await db
    .insert(messages)
    .values({ conversationId, sender: "system", body: `You tipped ${formatCents(amountCents)}`, clientMsgId: `${TIP_ROW_PREFIX}${fanId}:${idempotencyKey}` })
    .onConflictDoNothing({ target: messages.clientMsgId })
    .returning({ id: messages.id });
  // The row is unique per key, so it is what makes the thanks happen once: a retry that finds it written schedules
  // nothing, and a retry after a first call that charged but died before the row still gets its row and its thanks.
  if (!row) return { messageId: null };
  scheduleTurn(conversationId, schedule);
  return { messageId: row.id };
}

/**
 * Unlocks one of the fan's offers and, when this call bought it, schedules a turn in which she checks in about it.
 * A re-purchase of an item he already owned is a purchase too and gets one. A repeat of an offer already accepted
 * charges nothing and gets no check-in. `fanId` must come from the session.
 */
export async function unlockInChat(fanId: string, offerId: string, schedule: Schedule = afterResponse): Promise<UnlockResult> {
  const res = await unlockOffer(fanId, offerId);
  if (!res.alreadyUnlocked) scheduleTurn(res.conversationId, schedule);
  return res;
}
