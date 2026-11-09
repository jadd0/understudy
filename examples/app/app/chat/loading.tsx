import { ChatSkeleton } from "./skeleton";

export default function Loading() {
  return (
    <div className="flex min-h-0 flex-1">
      <ChatSkeleton />
    </div>
  );
}
