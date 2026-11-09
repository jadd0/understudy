// Decides which comment each of the owner's replies answered.
//
// A reply lives in a thread: a top-level comment (the root) and its child comments. The pairing is
// "replied_to_comment_id" (exact) when the reply opens with @handle and an earlier comment in the
// same thread is by that handle: the latest such comment before the reply wins. Anything else
// pairs to the thread root and says so with "thread_root".

// A handle never ends in a period, so one right after it ("@maddie. thanks") is punctuation.
const LEADING_MENTION = /^\s*@([A-Za-z0-9._]*[A-Za-z0-9_])/;

/**
 * @typedef {{ id: string, user: string, ts: number, text: string, nonText: boolean }} ThreadComment
 * @param {{ reply: ThreadComment, thread: ThreadComment[] }} input  thread is the root first, then its children
 * @returns {{ target: ThreadComment, basis: "replied_to_comment_id" | "thread_root" }}
 */
export function pairReply({ reply, thread }) {
  const root = thread[0];
  const mention = LEADING_MENTION.exec(reply.text)?.[1]?.toLowerCase();
  if (mention) {
    let best = null;
    for (const comment of thread) {
      if (comment.id === reply.id || comment.user.toLowerCase() !== mention || comment.ts >= reply.ts) continue;
      if (best === null || comment.ts >= best.ts) best = comment;
    }
    if (best) return { target: best, basis: "replied_to_comment_id" };
  }
  return { target: root, basis: "thread_root" };
}
