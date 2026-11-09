"use client";

import { useSyncExternalStore } from "react";
import { dayAndTime } from "@/lib/ui/local-time";

const subscribeNever = () => () => {};

/**
 * A server-read time shown in the viewer's timezone. The server does not know that zone, so its render leaves the
 * text out (a non-breaking space keeps the line's height) and the browser fills it in after hydration, as the chat
 * does with its clock times. Takes an ISO string, since a Date does not cross from a server component.
 */
export function LocalTime({ iso }: { iso: string }) {
  const mounted = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
  return <time dateTime={iso}>{mounted ? dayAndTime(new Date(iso)) : " "}</time>;
}
