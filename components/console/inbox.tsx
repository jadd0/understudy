import { RefreshOnEvent } from "@/components/chat/refresh-on-event";
import { ThreadList } from "@/components/ui/chat/thread-list";
import { SkeletonLine } from "@/components/ui/skeleton";
import { consoleCreatorFor, listInbox, type Viewer } from "@/lib/conversations/read";
import { matchesFilter, shortAge, type InboxFilter } from "@/lib/ui/inbox-badge";
import { creatorChannel, TS_CHANNEL } from "@/providers/pusher/channels";

const TABS: { label: string; filter: InboxFilter }[] = [
  { label: "All", filter: "all" },
  { label: "Needs you", filter: "needs" },
  { label: "AI", filter: "ai" },
];

/** How many row placeholders an inbox shows while its rows stream: about one desktop viewport. */
export const INBOX_PENDING_ROWS = 8;

type Base = "/console" | "/admin";
type Account = { name: string; roleLabel: string; image?: string | null };

/** The inbox frame that needs no query: title, the seat line, the filter tabs. Shared by the inbox and its skeleton. */
function chrome(role: Viewer["role"] | undefined, base: Base, filter: InboxFilter) {
  // An admin in the creator console gets the console's title, plus the creator's inbox events.
  const adminQueue = role === "admin" && base === "/admin";
  // Settings and Analytics live in the top navigation (AppShell); the header only names the seat.
  const seat = adminQueue ? "Trust & Safety" : role === "admin" ? "Creator console · admin" : role === "creator" ? "Creator" : null;
  return {
    title: adminQueue ? "Safety queue" : "Inbox",
    action: seat ? (
      <span className="text-[13px] font-medium text-muted-2">{seat}</span>
    ) : (
      <SkeletonLine width={64} lineHeight={19.5} bar={9} />
    ),
    tabs:
      role === "creator" || (role === undefined && base === "/console")
        ? TABS.map((t) => ({ label: t.label, href: t.filter === "all" ? base : `${base}?f=${t.filter}`, on: t.filter === filter }))
        : undefined,
  };
}

/**
 * The inbox both seats share: the creator's own conversations, or the Trust & Safety queue. Scoping is in `listInbox`.
 * A server section: the page wraps it in Suspense with `InboxSkeleton`.
 */
export async function Inbox({
  viewer,
  base,
  filter = "all",
  activeId,
  fullOnMobile = false,
  account,
}: {
  viewer: Viewer;
  base: Base;
  filter?: InboxFilter;
  activeId?: string;
  fullOnMobile?: boolean;
  account: Account;
}) {
  // The console listens to its creator's inbox events (an admin's console too); the admin queue to T&S only.
  const [inbox, creator] = await Promise.all([listInbox(viewer), base === "/console" ? consoleCreatorFor(viewer) : null]);
  const rows = inbox.filter((r) => viewer.role === "admin" || matchesFilter(r.badge, filter));
  return (
    <>
      <RefreshOnEvent channels={[...(viewer.role === "admin" ? [TS_CHANNEL] : []), ...(creator ? [creatorChannel(creator.id)] : [])]} />
      <ThreadList
        {...chrome(viewer.role, base, filter)}
        fullOnMobile={fullOnMobile}
        account={account}
        threads={rows.map((r) => ({
          id: r.id,
          name: r.fanName,
          preview: r.hasSuggestion ? `Suggested reply ready · ${r.preview}` : r.preview,
          time: shortAge(r.ageMs),
          href: `${base}/${r.id}`,
          badge: r.badge ?? undefined,
          note: r.dueNote ?? undefined,
          active: r.id === activeId,
          unread: r.badge === "Handoff" || r.badge === "T&S",
        }))}
      />
    </>
  );
}

/**
 * The inbox while its rows stream: the same frame with row placeholders. Without a role (a route's loading.tsx,
 * before the guard has run) the seat line and the account block are placeholders too.
 */
export function InboxSkeleton({
  role,
  base,
  filter = "all",
  fullOnMobile = false,
  account,
}: {
  role?: Viewer["role"];
  base: Base;
  filter?: InboxFilter;
  fullOnMobile?: boolean;
  account?: Account;
}) {
  return (
    <ThreadList
      {...chrome(role, base, filter)}
      fullOnMobile={fullOnMobile}
      account={account ?? "pending"}
      threads={[]}
      pending={INBOX_PENDING_ROWS}
    />
  );
}
