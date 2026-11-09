/** The right pane of the inbox index on desktop: nothing to load, so it is part of the shell. */
export function PickPane() {
  return (
    <main className="hidden min-w-0 flex-1 items-center justify-center md:flex">
      <p className="text-[15px] text-muted">Pick a conversation to read it.</p>
    </main>
  );
}
