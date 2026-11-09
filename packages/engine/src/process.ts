import type { EngineCtx } from "./ctx";
import { describeError, hasPendingWork, runTurn } from "./turn";

/** A fan who keeps writing could keep one invocation busy forever; the sweep picks up whatever is left. */
const MAX_TURNS_PER_RUN = 5;

/**
 * Answers a conversation until nothing unanswered is left: one turn, then another if the fan wrote, tipped or unlocked while it ran.
 * Safe to call from many places at once (every send, the sweep): a call that cannot take the lease returns at once.
 */
export async function processConversation(ctx: EngineCtx, conversationId: string): Promise<number> {
  let committed = 0;
  for (let i = 0; i < MAX_TURNS_PER_RUN; i++) {
    let result;
    try {
      result = await runTurn(ctx, conversationId);
    } catch (e) {
      console.error(`engine: processConversation ${describeError(e)}`);
      break;
    }
    if (result.status !== "committed") break;
    committed++;
    if (!(await hasPendingWork(ctx, conversationId, result.creatorId))) break;
  }
  return committed;
}
