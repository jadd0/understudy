import { describe, expect, test } from "vitest";
import { parseChannel, toPusherChannel, TS_CHANNEL } from "./channels";
import { idsOnly, PusherEvents, pusherKeysFromEnv } from "./events";

const CONV = "4c0b6a2e-1f3d-4a57-9d1e-0a1b2c3d4e5f";

function fake() {
  const calls: { channel: string; event: string; data: unknown }[] = [];
  return { calls, client: { trigger: async (channel: string, event: string, data: unknown) => void calls.push({ channel, event, data }) } };
}

describe("pusher events adapter", () => {
  test("maps the engine's channel and event names to Pusher's", async () => {
    const f = fake();
    await new PusherEvents(f.client).emit(`conversation:${CONV}`, "message.created", { messageId: CONV, deliverInMs: 1200 });
    await new PusherEvents(f.client).emit(`conversation:${CONV}`, "typing", { holdMs: 3000 });
    expect(f.calls).toEqual([
      { channel: `private-conversation-${CONV}`, event: "message.new", data: { messageId: CONV, deliverInMs: 1200 } },
      { channel: `private-conversation-${CONV}`, event: "typing.start", data: { holdMs: 3000 } },
    ]);
  });

  test("never sends a body: strings that are not ids are dropped", async () => {
    const f = fake();
    await new PusherEvents(f.client).emit("ts", "inbox.changed", { conversationId: CONV, body: "hello there", text: "secret", n: 1, ok: true, nested: { a: 1 } });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].channel).toBe(TS_CHANNEL);
    expect(f.calls[0].data).toEqual({ conversationId: CONV, n: 1, ok: true });
    expect(JSON.stringify(f.calls[0].data)).not.toContain("hello");
    expect(idsOnly({ body: "x".repeat(40) })).toEqual({});
  });

  test("channel names round-trip and unknown names do not parse", () => {
    expect(parseChannel(toPusherChannel(`creator:${CONV}`))).toEqual({ kind: "creator", id: CONV });
    expect(parseChannel(`private-conversation-${CONV}`)).toEqual({ kind: "conversation", id: CONV });
    expect(parseChannel("private-ts")).toEqual({ kind: "ts" });
    expect(parseChannel("private-conversation-not-a-uuid")).toBeNull();
    expect(parseChannel(`presence-conversation-${CONV}`)).toBeNull();
    expect(toPusherChannel(`conversation:${CONV}`)).not.toContain(":");
  });

  test("keys come from the environment only when all four exist", () => {
    expect(pusherKeysFromEnv({ PUSHER_APP_ID: "1", PUSHER_KEY: "k", PUSHER_SECRET: "s" })).toBeNull();
    expect(pusherKeysFromEnv({ PUSHER_APP_ID: "1", PUSHER_KEY: "k", PUSHER_SECRET: "s", PUSHER_CLUSTER: "eu" })).toEqual({
      appId: "1", key: "k", secret: "s", cluster: "eu",
    });
  });
});
