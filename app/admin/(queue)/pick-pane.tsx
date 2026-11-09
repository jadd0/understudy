import Link from "next/link";

/** The right pane of the safety queue on desktop: nothing to load, so it is part of the shell. */
export function PickPane() {
  return (
    <main className="hidden min-w-0 flex-1 items-center justify-center md:flex">
      <div className="flex flex-col items-center gap-2">
        <p className="text-[15px] text-muted">Pick a conversation from the safety queue.</p>
        <Link href="/admin/sim" className="text-[14px] font-medium text-accent underline">
          Fan simulator
        </Link>
      </div>
    </main>
  );
}
