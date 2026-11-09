import type { Events } from "@understudy/engine";
import { defaultEvents } from "@/providers/pusher/events";

let cached: Events | undefined;

/** The realtime port for server actions: Pusher when configured, else a no-op. */
export function getEvents(): Events {
  return (cached ??= defaultEvents());
}
