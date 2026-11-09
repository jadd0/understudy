"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { tickAction } from "./actions";

/** How long to wait after one tick returns before the next. */
const EVERY_MS = 6_000;

/**
 * While the page shows a live run, asks the server every few seconds to advance the live runs, then re-renders the
 * page so the beat column moves. It is what keeps runs going when no cron calls `/api/cron/sim` (a local dev server),
 * and the runs' leases keep it from driving a run the cron or a Spawn is already driving. The next tick is scheduled
 * only after the last one returned, so ticks never pile up.
 */
export function LiveTicker() {
  const router = useRouter();
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        await tickAction();
      } catch {
        // A failed tick (a deploy, a lost session) is retried on the next one; the page itself shows the state.
      }
      if (stopped) return;
      router.refresh();
      timer = setTimeout(tick, EVERY_MS);
    };
    timer = setTimeout(tick, EVERY_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [router]);
  return <p className="text-[13px] text-muted-2" aria-live="polite">Runs are live: this table updates every few seconds.</p>;
}
