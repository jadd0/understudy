import type { ReactNode } from "react";
import Link from "next/link";
import { Avatar } from "../avatar";
import { IconBack } from "../icons";

/** Conversation header: back link on mobile, avatar, name, "typing…"/status line, actions. */
export function ChatHeader({
  name,
  image = null,
  online = false,
  typing = false,
  status = "Active now",
  backHref,
  actions,
}: {
  name: string;
  image?: string | null;
  online?: boolean;
  typing?: boolean;
  status?: string;
  backHref?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex items-center gap-2 border-b border-line py-2.5 pr-1.5 pl-1 md:gap-3 md:py-3 md:pr-3.5 md:pl-6">
      {backHref ? (
        <Link
          href={backHref}
          aria-label="Back to messages"
          className="inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-hover md:hidden"
        >
          <IconBack />
        </Link>
      ) : null}
      <span className="md:hidden">
        <Avatar name={name} src={image} size="sm" online={online} decorative />
      </span>
      <span className="hidden md:block">
        <Avatar name={name} src={image} size="md" online={online} decorative />
      </span>
      <div className="ml-0.5 flex min-w-0 flex-1 flex-col gap-px md:ml-0">
        <span className="truncate text-[16px] font-semibold">{name}</span>
        {typing ? (
          <span className="text-[12px] font-medium text-accent md:text-[13px]">typing…</span>
        ) : (
          <span className="text-[12px] text-muted md:text-[13px]">{status}</span>
        )}
      </div>
      {actions}
    </header>
  );
}

/** The conversation's opening block (desktop only, as drawn): big avatar, name, one line about them. */
export function ChatIntro({ name, image = null, line }: { name: string; image?: string | null; line: string }) {
  return (
    <div className="hidden flex-col items-center gap-1 pt-9 pb-1.5 md:flex">
      <Avatar name={name} src={image} size="xl" decorative />
      <span className="mt-2 text-[18px] font-semibold">{name}</span>
      <span className="text-[13px] text-muted">{line}</span>
    </div>
  );
}
