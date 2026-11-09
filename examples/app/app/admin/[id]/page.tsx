import { Suspense } from "react";
import { notFound } from "next/navigation";
import { LiveThread } from "@/components/chat/live-thread";
import { ThreadSkeleton } from "@/components/chat/thread-skeleton";
import { Inbox } from "@/components/console/inbox";
import { accountName, roleLabel } from "@/lib/ui/account-label";
import { requireRole } from "@/lib/auth/guards";
import { assertVisible, ConversationNotFound } from "@/lib/conversations/read";
import { getWindowedSnapshot } from "@/lib/conversations/paging";
import { banAction, discardSuggestedAction, olderThread, refreshThread, releaseAction, replyAction, sendSuggestedAction, takeoverAction, threadChanges } from "../actions";

export const dynamic = "force-dynamic";

const ADMIN = "admin" as const;

export default async function AdminThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireRole("admin");
  const { id } = await params;
  const viewer = { id: user.id, role: ADMIN };
  // A malformed or unknown id is a 404, decided before the thread streams.
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  await assertVisible(viewer, id).catch((e) => {
    if (e instanceof ConversationNotFound) notFound();
    throw e;
  });
  const account = { name: accountName(user, "admin"), roleLabel: roleLabel("admin") };
  return (
    <div className="flex min-h-0 flex-1">
      {/* The inbox is part of this page's shell, not streamed: switching threads would remount its boundary and blank
          the list the user just clicked in. The shell waits for it; the thread streams. */}
      <Inbox account={account} viewer={viewer} base="/admin" activeId={id} />
      <Suspense key={id} fallback={<ThreadSkeleton staff />}>
        <AdminThread viewer={viewer} id={id} />
      </Suspense>
    </div>
  );
}

async function AdminThread({ viewer, id }: { viewer: { id: string; role: typeof ADMIN }; id: string }) {
  const snapshot = await getWindowedSnapshot(viewer, id).catch((e) => {
    if (e instanceof ConversationNotFound) notFound();
    throw e;
  });
  return (
    <LiveThread
      role="admin"
      initial={snapshot}
      creatorId={snapshot.thread.conversation.creatorId}
      header={{ name: snapshot.thread.conversation.fanName, backHref: "/admin" }}
      actions={{
        refresh: refreshThread.bind(null, id),
        older: olderThread.bind(null, id),
        changes: threadChanges.bind(null, id),
        send: replyAction.bind(null, id),
        takeover: takeoverAction.bind(null, id),
        release: releaseAction.bind(null, id),
        ban: banAction.bind(null, id),
        sendSuggested: sendSuggestedAction,
        discardSuggested: discardSuggestedAction,
      }}
    />
  );
}
