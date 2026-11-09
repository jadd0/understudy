import { Suspense } from "react";
import { Inbox, InboxSkeleton } from "@/components/console/inbox";
import { accountName, roleLabel } from "@/lib/ui/account-label";
import { requireConsole } from "@/lib/auth/guards";
import type { InboxFilter } from "@/lib/ui/inbox-badge";
import { PickPane } from "./pick-pane";

export const dynamic = "force-dynamic";

export default async function ConsolePage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  // A creator, or an admin, who sees the console of the creator consoleCreatorFor picks. The guard decides
  // before anything streams; the inbox rows stream behind their skeleton.
  const user = await requireConsole();
  const { f } = await searchParams;
  const filter: InboxFilter = f === "needs" || f === "ai" ? f : "all";
  const viewer = { id: user.id, role: user.role };
  const account = { name: accountName(user, user.role), roleLabel: roleLabel(user.role), image: user.image ?? null };
  return (
    <div className="flex min-h-0 flex-1">
      <Suspense key={filter} fallback={<InboxSkeleton role={user.role} base="/console" filter={filter} account={account} fullOnMobile />}>
        <Inbox account={account} viewer={viewer} base="/console" filter={filter} fullOnMobile />
      </Suspense>
      <PickPane />
    </div>
  );
}
