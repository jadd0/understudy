import { fanCreator } from "@/lib/conversations/read";

/** The wallet, remembering which creator's chat the fan came from. */
export const walletHrefFor = (handle: string) => `/wallet?c=${encodeURIComponent(handle)}`;

/** The chat for a handle that has already been checked; plain `/chat` when there is none. */
export const chatHrefFor = (handle: string | null | undefined) => (handle ? `/chat?c=${encodeURIComponent(handle)}` : "/chat");

/**
 * The chat the fan's wallet visit started from. `c` is client input (the URL, or a hidden form field): it counts only
 * when it names a creator this fan can reach, as on the chat page, and then comes back as that creator's own handle.
 * A made-up, repeated or missing one gives null, and the way back is plain `/chat`.
 */
export async function cameFrom(fanId: string, c: unknown): Promise<string | null> {
  if (typeof c !== "string" || c === "") return null;
  return (await fanCreator(fanId, c))?.handle ?? null;
}
