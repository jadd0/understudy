import type { ReactNode } from "react";
import { signOutAction } from "@/app/signout/actions";
import { auth } from "@/lib/auth";
import { readAccessUser } from "@/lib/auth/guards";
import { accountName, roleLabel } from "@/lib/ui/account-label";
import { navLinksFor } from "@/lib/ui/app-nav";
import { AppNavLinks } from "./app-nav-links";
import { Avatar } from "./avatar";
import { IconSignOut } from "./icons";

/**
 * Every signed-in section's frame: a top bar with the sections this user may open, who is signed in, and Sign out,
 * above a content area that fills the rest of the viewport. Links come from the user row read fresh on the server.
 * The page's own guard still decides access; with no user (or no links) the bar is left out and the page fills the frame.
 */
export async function AppShell({ children }: { children: ReactNode }) {
  const session = await auth();
  const user = await readAccessUser(session?.user?.id);
  const links = navLinksFor(user);
  if (!user || links.length === 0) return <div className="flex h-dvh min-h-0 flex-col">{children}</div>;
  const name = accountName(user, user.role);
  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-ground pr-2 pl-3 md:gap-4 md:pr-3 md:pl-5">
        <span className="hidden text-[15px] font-semibold tracking-[-0.02em] md:inline">Understudy</span>
        <nav aria-label="Sections" className="flex min-w-0 flex-1">
          <AppNavLinks links={links} />
        </nav>
        <div className="flex shrink-0 items-center gap-2.5" title={`Signed in as ${name} (${roleLabel(user.role)})`}>
          <Avatar name={name} src={user.image} size="xs" decorative />
          <span className="hidden max-w-[180px] flex-col gap-px leading-tight lg:flex">
            <span className="truncate text-[13px] font-semibold">{name}</span>
            <span className="text-[11px] text-muted">{roleLabel(user.role)}</span>
          </span>
          <span className="sr-only lg:hidden">
            Signed in as {name}, {roleLabel(user.role)}
          </span>
        </div>
        <form action={signOutAction} className="shrink-0">
          <button
            type="submit"
            aria-label="Sign out"
            className="inline-flex h-9 items-center gap-1.5 rounded-2xl px-2.5 text-[13px] font-medium text-muted-2 transition-colors hover:bg-hover hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <IconSignOut width={16} height={16} aria-hidden="true" />
            <span className="hidden md:inline">Sign out</span>
          </button>
        </form>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
    </div>
  );
}
