import Pusher from "pusher";
import type { Events } from "@jadd0/understudy-engine";
import { noopEvents } from "@jadd0/understudy-providers";
import { EVENT_RENAMES, toPusherChannel } from "./channels";

/** The slice of the Pusher server SDK this adapter uses, so tests inject a fake. */
export interface PusherLike {
  trigger(channel: string, event: string, data: unknown): Promise<unknown>;
}

const ID = /^[0-9a-f-]{36}$/;

/**
 * Events say "refetch", never "here is the text" (the database is the truth): only numbers, booleans and
 * uuid-shaped strings survive. Anything else, a message body included, is dropped.
 */
export function idsOnly(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && ID.test(v))) out[k] = v;
  }
  return out;
}

export class PusherEvents implements Events {
  constructor(private readonly client: PusherLike) {}

  async emit(channel: string, event: string, payload: Record<string, unknown>): Promise<void> {
    await this.client.trigger(toPusherChannel(channel), EVENT_RENAMES[event] ?? event, idsOnly(payload));
  }
}

export interface PusherKeys {
  appId: string;
  key: string;
  secret: string;
  cluster: string;
}

export function pusherKeysFromEnv(env: Record<string, string | undefined> = process.env): PusherKeys | null {
  const { PUSHER_APP_ID: appId, PUSHER_KEY: key, PUSHER_SECRET: secret, PUSHER_CLUSTER: cluster } = env;
  return appId && key && secret && cluster ? { appId, key, secret, cluster } : null;
}

export function createPusherServer(keys: PusherKeys) {
  return new Pusher({ ...keys, useTLS: true });
}

/** Pusher when its keys exist; otherwise nothing is emitted and the browser polls. */
export function defaultEvents(): Events {
  const keys = pusherKeysFromEnv();
  return keys ? new PusherEvents(createPusherServer(keys)) : noopEvents;
}
