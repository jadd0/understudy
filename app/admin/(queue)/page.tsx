import { Suspense } from "react";
import { Inbox, InboxSkeleton } from "@/components/console/inbox";
import { accountName, roleLabel } from "@/lib/ui/account-label";
import { requireRole } from "@/lib/auth/guards";
import { PickPane } from "./pick-pane";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  // The guard decides before anything streams; the queue's rows stream behind their skeleton.
  const user = await requireRole("admin");
  const account = { name: accountName(user, "admin"), roleLabel: roleLabel("admin") };
  return (
    <div className="flex min-h-0 flex-1">
      <Suspense fallback={<InboxSkeleton role="admin" base="/admin" account={account} fullOnMobile />}>
        <Inbox account={account} viewer={{ id: user.id, role: "admin" }} base="/admin" fullOnMobile />
      </Suspense>
      <PickPane />
    </div>
  );
}
