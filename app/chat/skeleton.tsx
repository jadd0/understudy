import { ThreadSkeleton } from "@/components/chat/thread-skeleton";
import { IconButton } from "@/components/ui/button";
import { ThreadList } from "@/components/ui/chat/thread-list";
import { IconCompose } from "@/components/ui/icons";

/** The fan's chat while it streams: the sidebar frame with one pending row, and the thread skeleton. */
export function ChatSkeleton({ account }: { account?: { name: string; roleLabel: string } }) {
  return (
    <>
      <ThreadList
        title="Messages"
        threads={[]}
        pending={1}
        account={account ?? "pending"}
        action={
          <IconButton label="New message" disabled>
            <IconCompose />
          </IconButton>
        }
      />
      <ThreadSkeleton fan />
    </>
  );
}
