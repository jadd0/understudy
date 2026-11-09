"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useRealtime } from "./use-realtime";

const POLL_MS = 5000;

/** Re-renders the server page (an inbox list) when an event arrives on its channels; polls when Pusher is off. */
export function RefreshOnEvent({ channels }: { channels: string[] }) {
  const router = useRouter();
  const refresh = useCallback(() => router.refresh(), [router]);
  const live = Boolean(process.env.NEXT_PUBLIC_PUSHER_KEY && process.env.NEXT_PUBLIC_PUSHER_CLUSTER);
  // Handoffs the engine opens emit nothing yet, so the list also polls slowly when live.
  useRealtime(channels, refresh, live ? POLL_MS * 6 : POLL_MS);
  return null;
}
