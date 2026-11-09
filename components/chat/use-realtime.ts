"use client";

import { useEffect, useRef } from "react";

const EVENTS = ["typing.start", "message.new", "conversation.mode", "inbox.changed"];

/**
 * Subscribes to private channels and calls `onEvent` for any event. Events carry ids only: the handler
 * refetches. Without Pusher keys the caller polls instead (`pollMs`), and also while an event is overdue.
 */
export function useRealtime(channels: readonly string[], onEvent: () => void, pollMs: number | null) {
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  });
  const key = process.env.NEXT_PUBLIC_PUSHER_KEY;
  const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;
  const names = channels.join("|");

  useEffect(() => {
    if (!key || !cluster || !names) return;
    let closed = false;
    let disconnect: (() => void) | undefined;
    void import("pusher-js").then(({ default: Pusher }) => {
      if (closed) return;
      const client = new Pusher(key, { cluster, channelAuthorization: { endpoint: "/api/pusher/auth", transport: "ajax" } });
      for (const name of names.split("|")) {
        const channel = client.subscribe(name);
        for (const e of EVENTS) channel.bind(e, () => handler.current());
      }
      // A reconnect may have missed events: refetch once.
      client.connection.bind("connected", () => handler.current());
      disconnect = () => client.disconnect();
    });
    return () => {
      closed = true;
      disconnect?.();
    };
  }, [key, cluster, names]);

  useEffect(() => {
    if (!pollMs) return;
    const t = setInterval(() => handler.current(), pollMs);
    return () => clearInterval(t);
  }, [pollMs]);

  return Boolean(key && cluster);
}
