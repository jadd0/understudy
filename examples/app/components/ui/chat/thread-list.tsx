import Link from "next/link";
import { Avatar } from "../avatar";
import { Badge, badgeTone } from "../badge";
import { IconSearch } from "../icons";
import { SkeletonAvatar, SkeletonGroup, SkeletonLine, SkeletonRows } from "../skeleton";
import { AccountMenu } from "./account-menu";
import { ResizableSidebar } from "./resizable-sidebar";

export interface ThreadSummary {
  readonly id: string;
  readonly name: string;
  /** A profile photo; without one the row shows initials. */
  readonly image?: string | null;
  readonly preview: string;
  readonly time: string;
  readonly href: string;
  readonly unread?: boolean;
  /** How many unread messages; shown as the count badge. Without it an unread thread shows a dot. */
  readonly unreadCount?: number;
  readonly online?: boolean;
  readonly active?: boolean;
  /** The other side is typing: the preview becomes an accent "typing…". */
  readonly typing?: boolean;
  /** Small status chip (e.g. "Handoff", "T&S", "AI"), shown after the name. */
  readonly badge?: string;
  /** A quiet line under the preview: when a handoff settles itself, or how long it has waited. */
  readonly note?: string;
}

/** The sidebar from the chat design (320px, resizable on desktop): title, search, tabs, thread rows, and the account block. */
export function ThreadList({
  title,
  threads,
  tabs,
  action,
  fullOnMobile = false,
  account,
  pending,
}: {
  title: string;
  threads: readonly ThreadSummary[];
  tabs?: readonly { label: string; href: string; on?: boolean }[];
  action?: React.ReactNode;
  /** Show the list full width on a phone (an inbox index); otherwise it is desktop-only and the thread fills the phone. */
  fullOnMobile?: boolean;
  /** Who is signed in; the block at the bottom opens the account menu. "pending" draws its placeholder (a route's loading.tsx). */
  account?: { name: string; roleLabel: string; image?: string | null } | "pending";
  /** While the rows stream: this many row placeholders instead of `threads`; the rest of the frame is real. */
  pending?: number;
}) {
  return (
    <ResizableSidebar
      className={`min-h-0 shrink-0 flex-col border-r border-line md:w-(--sidebar-w) ${fullOnMobile ? "flex w-full flex-1 md:flex-none" : "hidden md:flex"}`}
    >
      <div className="flex h-[72px] shrink-0 items-center justify-between border-b border-line pr-2.5 pl-5">
        <h1 className="text-[20px] font-semibold tracking-[-0.02em]">{title}</h1>
        {action}
      </div>
      <div className="flex flex-col gap-3 px-2 pt-3 pb-2">
        <div className="flex h-10 items-center gap-2.5 rounded-[20px] bg-surface pr-3.5 pl-3">
          <IconSearch className="text-muted" />
          <label htmlFor="thread-search" className="sr-only">
            Search messages
          </label>
          <input
            id="thread-search"
            type="search"
            placeholder="Search"
            className="min-w-0 flex-1 border-0 bg-transparent text-[14px] outline-none placeholder:text-muted"
          />
        </div>
        {tabs ? (
          <nav className="flex gap-1.5" aria-label="Filter">
            {tabs.map((t) => (
              <Link
                key={t.href}
                href={t.href}
                className={`inline-flex h-8 items-center rounded-2xl px-3 text-[13px] font-medium ${t.on ? "bg-ink text-ground" : "text-muted-2 hover:bg-hover"}`}
              >
                {t.label}
              </Link>
            ))}
          </nav>
        ) : null}
      </div>
      <nav aria-label="Conversations" className="scroll-thin flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
        {pending ? (
          <SkeletonGroup label="Loading conversations" className="flex flex-col gap-0.5">
            <SkeletonRows count={pending} />
          </SkeletonGroup>
        ) : null}
        {!pending && threads.length === 0 ? <p className="px-4 py-6 text-[14px] text-muted">No conversations yet.</p> : null}
        {(pending ? [] : threads).map((t) => (
          <Link
            key={t.id}
            href={t.href}
            aria-current={t.active ? "page" : undefined}
            className={`flex w-full items-center gap-3 rounded-[14px] px-3 py-2.5 text-left transition-colors ${t.active ? "bg-surface" : "hover:bg-hover"}`}
          >
            <Avatar name={t.name} src={t.image} size="row" online={t.online} decorative />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-baseline gap-2">
                <span className={`min-w-0 flex-1 truncate text-[15px] ${t.unread ? "font-semibold" : "font-medium"}`}>
                  {t.name}
                </span>
                {t.badge ? <Badge tone={badgeTone(t.badge)}>{t.badge}</Badge> : null}
                <span className="shrink-0 text-[12px] text-muted">{t.time}</span>
              </span>
              <span className="flex items-center gap-2">
                <span
                  className={`min-w-0 flex-1 truncate text-[13px] ${t.typing ? "font-semibold text-accent" : t.unread ? "font-semibold text-ink" : "text-muted"}`}
                >
                  {t.typing ? "typing…" : t.preview}
                </span>
                {t.unread && t.unreadCount ? (
                  <span
                    className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-[10px] bg-accent px-1.5 text-[11px] font-semibold text-white"
                    aria-label="unread messages"
                  >
                    {t.unreadCount}
                  </span>
                ) : t.unread ? (
                  <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />
                ) : null}
              </span>
              {t.note ? <span className="truncate text-[12px] text-muted">{t.note}</span> : null}
            </span>
          </Link>
        ))}
      </nav>
      {account === "pending" ? (
        <div className="border-t border-line p-2">
          <span className="flex w-full items-center gap-3 px-3 py-2">
            <SkeletonAvatar size={40} />
            <span className="flex min-w-0 flex-1 flex-col gap-px">
              <SkeletonLine width="55%" lineHeight={21} bar={10} />
              <SkeletonLine width="30%" lineHeight={18} bar={8} />
            </span>
          </span>
        </div>
      ) : account ? (
        <AccountMenu name={account.name} roleLabel={account.roleLabel} image={account.image} />
      ) : null}
    </ResizableSidebar>
  );
}
