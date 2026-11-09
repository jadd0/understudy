import { InboxSkeleton } from "@/components/console/inbox";
import { PickPane } from "./pick-pane";

export default function Loading() {
  return (
    <div className="flex min-h-0 flex-1">
      <InboxSkeleton role="admin" base="/admin" fullOnMobile />
      <PickPane />
    </div>
  );
}
