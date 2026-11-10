import { Suspense } from "react";
import { notFound } from "next/navigation";
import { LiveThread } from "@/components/chat/live-thread";
import { ThreadSkeleton } from "@/components/chat/thread-skeleton";
import { Inbox } from "@/components/console/inbox";
import { accountName, roleLabel } from "@/lib/ui/account-label";
import { requireConsole } from "@/lib/auth/guards";
import { assertVisible, consoleCreatorFor, ConversationNotFound, offerableItems, type Viewer } from "@/lib/conversations/read";
import { getWindowedSnapshot } from "@/lib/conversations/paging";
import {
  conversationAiAction, discardSuggestedAction, handBackAction, olderThread, refreshThread, releaseAction, replyAction, sendOfferAction, sendSuggestedAction, takeoverAction, threadChanges,
} from "../actions";

export const dynamic = "force-dynamic";

export default async function ConsoleThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireConsole();
  const { id } = await params;
  const viewer = { id: user.id, role: user.role };
  // A malformed id or a conversation outside her scope is the same 404 as one that does not exist, decided before
  // the thread streams.
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  await assertVisible(viewer, id).catch((e) => {
    if (e instanceof ConversationNotFound) notFound();
    throw e;
  });
  const account = { name: accountName(user, user.role), roleLabel: roleLabel(user.role), image: user.image ?? null };
  return (
    <div className="flex min-h-0 flex-1">
      {/* The inbox is part of this page's shell, not streamed: switching threads would remount its boundary and blank
          the list the user just clicked in. The shell waits for it; the thread streams. */}
      <Inbox account={account} viewer={viewer} base="/console" activeId={id} />
      <Suspense key={id} fallback={<ThreadSkeleton staff />}>
        <ConsoleThread viewer={viewer} id={id} />
      </Suspense>
    </div>
  );
}

async function ConsoleThread({ viewer, id }: { viewer: Viewer & { role: "creator" | "admin" }; id: string }) {
  const snapshotP = getWindowedSnapshot(viewer, id).catch((e) => {
    if (e instanceof ConversationNotFound) notFound();
    throw e;
  });
  const creator = await consoleCreatorFor(viewer);
  // Offers are the creator's alone (sendOfferAsCreator); an admin gets no offer picker.
  const [snapshot, offerItems] = await Promise.all([
    snapshotP,
    creator && viewer.role === "creator"
      ? offerableItems(creator.id)
      : [],
  ]);
  return (
    // An admin gets the admin thread controls (takeover to T&S, release), and its actions are attributed to it.
    <LiveThread
      role={viewer.role}
      initial={snapshot}
      creatorId={snapshot.thread.conversation.creatorId}
      offerItems={offerItems}
      header={{ name: snapshot.thread.conversation.fanName, backHref: "/console" }}
      actions={{
        refresh: refreshThread.bind(null, id),
        older: olderThread.bind(null, id),
        changes: threadChanges.bind(null, id),
        send: replyAction.bind(null, id),
        takeover: takeoverAction.bind(null, id),
        ...(viewer.role === "admin"
          ? { release: releaseAction.bind(null, id) }
          : { handBack: handBackAction.bind(null, id), setAi: conversationAiAction.bind(null, id), sendOffer: sendOfferAction.bind(null, id) }),
        sendSuggested: sendSuggestedAction,
        discardSuggested: discardSuggestedAction,
      }}
    />
  );
}
