"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeHref, type NavLink } from "@/lib/ui/active-href";

/**
 * The section links. The server decides which links exist; this only marks the one the current path sits under,
 * because a layout keeps its render across sibling pages and never receives the pathname itself.
 */
export function AppNavLinks({ links }: { links: readonly NavLink[] }) {
  const current = activeHref(links, usePathname());
  return (
    <ul className="scroll-thin flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
      {links.map((l) => {
        const on = l.href === current;
        return (
          <li key={l.href} className="shrink-0">
            <Link
              href={l.href}
              aria-current={on ? "page" : undefined}
              className={`inline-flex h-9 items-center rounded-2xl px-3 text-[13px] font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                on ? "bg-surface text-ink" : "text-muted-2 hover:bg-hover hover:text-ink"
              }`}
            >
              {l.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
