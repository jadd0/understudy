import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { LiveThread } from "@/components/chat/live-thread";
import { IconButton } from "@/components/ui/button";
import { IconCompose, IconWallet } from "@/components/ui/icons";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { MINOR_IN_CHAT, requireChatReader } from "@/lib/auth/guards";
import { getFanWindowedSnapshot } from "@/lib/conversations/paging";
import { creatorByHandle } from "@/lib/conversations/read";
import { getConfig } from "@/lib/config";
import { accountName, roleLabel } from "@/lib/ui/account-label";
import {
  chatChanges,
  olderChat,
  refreshChat,
  pingTyping,
  sendMessage,
  tipAction,
  unlockOfferAction,
} from "./actions";
import { ChatSkeleton } from "./skeleton";

export const dynamic = "force-dynamic";
// A server action here schedules the engine's reply with `after`; it needs the engine's full budget
// (lib/chat/send.ts ENGINE_MAX_DURATION_S). Route segment config must be a literal.
export const maxDuration = 60;

type Account = { name: string; roleLabel: string };

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // The guard decides before anything streams; the thread itself streams behind the skeleton.
  const user = await requireChatReader();
  // `?c=<handle>` names the creator; without it the fan talks to the default creator. A repeated `c` names nobody.
  const { c } = await searchParams;
  if (Array.isArray(c)) notFound();
  const handle = c ?? null;
  // Decided before the thread streams, so a handle nobody has is a real 404 and not a page that fails midway.
  if (handle !== null && !(await creatorByHandle(handle))) notFound();
  const account: Account = {
    name: accountName(user, "fan"),
    roleLabel: roleLabel("fan"),
  };
  return (
    <div className="flex min-h-0 flex-1">
      <Suspense fallback={<ChatSkeleton account={account} />}>
        <ChatThread fanId={user.id} handle={handle} account={account} />
      </Suspense>
    </div>
  );
}

/** The fan's one thread: restriction, snapshot and tip settings, read on the server and handed to LiveThread. */
async function ChatThread({
  fanId,
  handle,
  account,
}: {
  fanId: string;
  handle: string | null;
  account: Account;
}) {
  const [row] = await db
    .select({ flagReason: users.flagReason, flaggedAt: users.flaggedAt })
    .from(users)
    .where(eq(users.id, fanId));
  // A fan restricted as a minor in chat reads their history; sending is refused server-side as well.
  const restricted =
    Boolean(row?.flaggedAt) && row?.flagReason === MINOR_IN_CHAT;
  const found = await getFanWindowedSnapshot(fanId, handle);
  if (!found) notFound();
  const { snapshot, creator } = found;
  const tipOptions = restricted
    ? undefined
    : {
        presets: await getConfig<number[]>("wallet.tip_options_cents"),
        minCents: await getConfig<number>("wallet.tip_min_cents"),
      };

  return (
    <LiveThread
      role="fan"
      sidebar={{
        title: "Messages",
        thread: {
          id: creator.id,
          name: creator.displayName,
          image: creator.image,
          href: handle === null ? "/chat" : `/chat?c=${encodeURIComponent(handle)}`,
          active: true,
          online: true,
        },
        account,
        action: (
          <IconButton label="New message" disabled>
            <IconCompose />
          </IconButton>
        ),
      }}
      initial={snapshot}
      creatorId={creator.id}
      introLine={`@${creator.handle}`}
      walletHref="/wallet"
      tipOptions={tipOptions}
      readOnlyNotice={
        restricted ? "Messaging is turned off for this account." : undefined
      }
      header={{
        name: creator.displayName,
        actions: (
          <>
            {restricted ? null : (
              <Link
                href="/wallet"
                aria-label="Wallet"
                className="inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-hover"
              >
                <IconWallet />
              </Link>
            )}
          </>
        ),
      }}
      actions={{
        // Bound here, on the server, so the thread's client code never types the handle.
        refresh: refreshChat.bind(null, handle),
        older: olderChat.bind(null, handle),
        changes: chatChanges.bind(null, handle),
        send: sendMessage.bind(null, handle),
        typing: restricted ? undefined : pingTyping.bind(null, handle),
        unlock: restricted ? undefined : unlockOfferAction,
        tip: restricted ? undefined : tipAction.bind(null, handle),
      }}
    />
  );
}
