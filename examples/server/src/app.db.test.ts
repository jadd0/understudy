import { createServer, type Server } from "node:http";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { db } from "@/db/client";
import { conversations, messages } from "@understudy/engine/schema";
import { makeConversation } from "@understudy/engine/testing";
import { buildServer } from "./app";
import { FAKE_REPLIES } from "./providers";
import { API_KEY, auth, testServer, type TestServer } from "./test-helpers";

let s: TestServer;
beforeAll(async () => {
  s = await testServer({ listen: true });
});
afterAll(async () => {
  await s.close();
});

const post = (url: string, payload?: unknown, headers: Record<string, string> = auth) =>
  s.app.inject({ method: "POST", url, headers, payload: payload as object | undefined });
const send = (fanId: string, body: string, clientMsgId: string = crypto.randomUUID()) =>
  post("/v1/messages", { creatorId: s.creatorId, fanId, body, clientMsgId });
const ai = async (conversationId: string) =>
  (await db.select().from(messages).where(eq(messages.conversationId, conversationId))).filter((m) => m.sender === "ai" && m.status === "sent");
const creatorActor = (creatorId = s.creatorId) => ({ actorId: crypto.randomUUID(), side: "creator", creatorId });

/** Reads an SSE response into parsed events; `close` aborts the request. */
function openStream(conversationId: string, base = s.url) {
  const ctl = new AbortController();
  const got: { event: string; data: Record<string, unknown>; at: number }[] = [];
  const ready = fetch(`${base}/v1/conversations/${conversationId}/events`, { headers: auth, signal: ctl.signal }).then(async (res) => {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (ev && data) got.push({ event: ev, data: JSON.parse(data), at: Date.now() });
      }
    }
  });
  ready.catch(() => undefined);
  return { got, close: () => ctl.abort() };
}

describe("auth", () => {
  test("a message without the API key is 401", async () => {
    const body = { creatorId: s.creatorId, fanId: crypto.randomUUID(), body: "hi", clientMsgId: crypto.randomUUID() };
    expect((await post("/v1/messages", body, {})).statusCode).toBe(401);
    expect((await post("/v1/messages", body, { authorization: "Basic abc" })).statusCode).toBe(401);
    expect((await s.app.inject({ method: "GET", url: `/v1/conversations/${crypto.randomUUID()}/events` })).statusCode).toBe(401);
    expect((await s.app.inject({ method: "GET", url: "/health" })).json()).toEqual({ ok: true });
  });

  test("a wrong key of the same length is 401, the right one passes", async () => {
    const wrong = API_KEY.slice(0, -1) + (API_KEY.endsWith("f") ? "e" : "f");
    expect(wrong).toHaveLength(API_KEY.length);
    const body = { creatorId: s.creatorId, fanId: crypto.randomUUID(), body: "hi", clientMsgId: crypto.randomUUID() };
    expect((await post("/v1/messages", body, { authorization: `Bearer ${wrong}` })).statusCode).toBe(401);
    expect((await post("/v1/messages", body)).statusCode).toBe(202);
    await s.app.idle();
  });
});

describe("server errors", () => {
  test("a failing engine call answers {code: internal} and neither the response nor the log carries the fan's words", async () => {
    const secret = "SECRETBODY-" + crypto.randomUUID();
    const lines: string[] = [];
    const chatter = { ...s.chatter, handleMessage: async () => { throw new Error(`Failed query: insert into messages params: ${secret}`); } };
    const app = buildServer({
      chatter: chatter as typeof s.chatter,
      apiKey: API_KEY,
      bus: s.bus,
      store: { isFlagged: async () => false, modeOf: async () => null },
      logger: { level: "info", stream: { write: (l: string) => void lines.push(l) } },
    });
    const res = await app.inject({ method: "POST", url: "/v1/messages", headers: auth, payload: { creatorId: s.creatorId, fanId: crypto.randomUUID(), body: secret, clientMsgId: "c-1" } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ code: "internal" });
    expect(res.body).not.toContain(secret);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("request failed"))).toBe(true);
    expect(lines.join("")).not.toContain(secret);
    // Client errors keep their own responses.
    expect((await app.inject({ method: "POST", url: "/v1/messages", headers: auth, payload: { creatorId: "x" } })).statusCode).toBe(400);
    await app.close();
  });
});

describe("messages", () => {
  test("POST /v1/messages stores the message and the turn replies", async () => {
    const fanId = crypto.randomUUID();
    const res = await send(fanId, "hey juno");
    expect(res.statusCode).toBe(202);
    const { conversationId, messageId, duplicate } = res.json();
    expect(duplicate).toBe(false);
    await s.app.idle();
    const rows = await db.select().from(messages).where(eq(messages.conversationId, conversationId));
    expect(rows.find((m) => m.id === messageId)).toMatchObject({ sender: "fan", body: "hey juno", senderUserId: fanId });
    const replies = await ai(conversationId);
    expect(replies.length).toBeGreaterThan(0);
    // The scripted generator answers in order; the server is shared, so which line this is depends on the tests before it.
    const lines = FAKE_REPLIES.flatMap((r) => r.split("\n"));
    expect(replies.every((r) => lines.includes(r.body))).toBe(true);
  });

  test("the same clientMsgId returns duplicate true and runs no second turn", async () => {
    const fanId = crypto.randomUUID();
    const cid = crypto.randomUUID();
    const first = await send(fanId, "hello there", cid);
    await s.app.idle();
    const { conversationId, messageId } = first.json();
    const before = (await ai(conversationId)).length;
    const again = await send(fanId, "hello there", cid);
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual({ conversationId, messageId, duplicate: true });
    await s.app.idle();
    expect((await ai(conversationId)).length).toBe(before);
    // Another fan cannot reuse the id.
    const other = await send(crypto.randomUUID(), "hello there", cid);
    expect(other.statusCode).toBe(422);
    expect(other.json()).toEqual({ code: "not_owner" });
  });

  test("an empty body is 422 empty", async () => {
    const res = await send(crypto.randomUUID(), "   ");
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ code: "empty" });
    expect((await send(crypto.randomUUID(), "x".repeat(2001))).json()).toEqual({ code: "too_long" });
    expect((await post("/v1/messages", { creatorId: "nope" })).statusCode).toBe(400);
  });

  test("a flagged fan is 403", async () => {
    const fanId = crypto.randomUUID();
    await db.execute(sql`insert into server_flags (fan_id, reason) values (${fanId}, 'minor_in_chat')`);
    const res = await send(fanId, "hey");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ code: "restricted" });
    expect(await db.select().from(conversations).where(eq(conversations.fanId, fanId))).toHaveLength(0);
  });
});

describe("events stream", () => {
  test("the reply bubble arrives after its delay, to every open client once, and a closed client leaks nothing", async () => {
    // A slow typist: the first bubble is due about a second after the turn commits.
    const slow = await testServer({ listen: true, rows: { "engine.typing_cps": 20, "engine.typing_max_ms": 5000, "delivery.bubble_gap_ms_min": 300, "delivery.bubble_gap_ms_max": 300 } });
    try {
      const fanId = crypto.randomUUID();
      const conv = await makeConversation(slow.creatorId, fanId);
      const key = auth;
      const read = (id: string) => openStream(id, slow.url);
      const a = read(conv.id);
      const b = read(conv.id);
      const c = read(conv.id);
      await vi.waitFor(() => expect(slow.bus.subscriberCount()).toBe(3));
      const sentAt = Date.now();
      const res = await slow.app.inject({ method: "POST", url: "/v1/messages", headers: key, payload: { creatorId: slow.creatorId, fanId, body: "hey juno", clientMsgId: crypto.randomUUID() } });
      expect(res.statusCode).toBe(202);
      expect(res.json().conversationId).toBe(conv.id);
      c.close();
      await vi.waitFor(() => expect(slow.bus.subscriberCount()).toBe(2));

      await vi.waitFor(() => expect(a.got.filter((e) => e.event === "message")).toHaveLength(2), { timeout: 15_000, interval: 50 });
      await vi.waitFor(() => expect(b.got.filter((e) => e.event === "message")).toHaveLength(2), { timeout: 15_000, interval: 50 });
      for (const client of [a, b]) {
        const bubbles = client.got.filter((e) => e.event === "message");
        expect(bubbles.map((e) => e.data.body)).toEqual(["hey you. found me then", "biscuit is very impressed"]);
        expect(bubbles[0].data).toMatchObject({ sender: "ai" });
        expect(typeof bubbles[0].data.id).toBe("string");
        // Due after its typing delay, not at commit time.
        expect(bubbles[0].at - sentAt).toBeGreaterThanOrEqual(400);
        expect(client.got.some((e) => e.event === "typing")).toBe(true);
        expect(client.got.findIndex((e) => e.event === "typing")).toBeLessThan(client.got.findIndex((e) => e.event === "message"));
      }
      // The closed client heard nothing after it left.
      expect(c.got.filter((e) => e.event === "message")).toHaveLength(0);

      const t = await slow.app.inject({ method: "POST", url: `/v1/conversations/${conv.id}/takeover`, headers: key, payload: { actorId: crypto.randomUUID(), side: "creator", creatorId: slow.creatorId } });
      expect(t.statusCode).toBe(204);
      await vi.waitFor(() => expect(a.got.some((e) => e.event === "mode" && e.data.mode === "human_creator")).toBe(true));
      await vi.waitFor(() => expect(b.got.filter((e) => e.event === "mode")).toHaveLength(1));

      a.close();
      b.close();
      await vi.waitFor(() => expect(slow.bus.subscriberCount()).toBe(0));
    } finally {
      await slow.close();
    }
  }, 40_000);

  test("an offer rides on the bubble with the item's title and price", async () => {
    const fanId = crypto.randomUUID();
    const conv = await makeConversation(s.creatorId, fanId);
    const stream = openStream(conv.id);
    await vi.waitFor(() => expect(s.bus.subscriberCount()).toBeGreaterThan(0));
    await send(fanId, "love the photos, got anything new i can see?");
    await vi.waitFor(() => expect(stream.got.some((e) => e.event === "message" && e.data.offer)).toBe(true), { timeout: 10_000, interval: 50 });
    const withOffer = stream.got.find((e) => e.event === "message" && e.data.offer)!;
    expect(withOffer.data.offer).toMatchObject({ title: "Golden hour", priceCents: 999 });
    stream.close();
    await vi.waitFor(() => expect(s.bus.subscriberCount()).toBe(0));
  });
});

describe("human takeover", () => {
  test("takeover stops the AI: a message after takeover gets no reply", async () => {
    const fanId = crypto.randomUUID();
    const first = await send(fanId, "hey juno");
    const { conversationId } = first.json();
    await s.app.idle();
    const before = (await ai(conversationId)).length;
    expect(before).toBeGreaterThan(0);

    const t = await post(`/v1/conversations/${conversationId}/takeover`, creatorActor());
    expect(t.statusCode).toBe(204);
    expect((await db.select().from(conversations).where(eq(conversations.id, conversationId)))[0].mode).toBe("human_creator");
    const second = await send(fanId, "are you there?");
    expect(second.statusCode).toBe(202);
    await s.app.idle();
    expect((await ai(conversationId)).length).toBe(before);

    // The human speaks only for a chat she holds.
    const actor = creatorActor();
    expect((await post(`/v1/conversations/${conversationId}/human-messages`, { ...actor, body: "hi, it's juno" })).statusCode).toBe(201);
    const rows = await db.select().from(messages).where(eq(messages.conversationId, conversationId));
    expect(rows.filter((m) => m.sender === "creator").map((m) => m.body)).toEqual(["hi, it's juno"]);
  });

  test("a creator actor cannot take over a T&S conversation (409), nor another creator's", async () => {
    const fanId = crypto.randomUUID();
    const { conversationId } = (await send(fanId, "hey juno")).json();
    await s.app.idle();

    // Another creator's id on this creator's conversation.
    const other = await post(`/v1/conversations/${conversationId}/takeover`, creatorActor(crypto.randomUUID()));
    expect(other.statusCode).toBe(409);
    expect(other.json()).toEqual({ code: "not_allowed" });
    expect((await db.select().from(conversations).where(eq(conversations.id, conversationId)))[0].mode).toBe("ai");

    // T&S takes it; the creator side is then locked out.
    expect((await post(`/v1/conversations/${conversationId}/takeover`, { actorId: crypto.randomUUID(), side: "ts" })).statusCode).toBe(204);
    const locked = await post(`/v1/conversations/${conversationId}/takeover`, creatorActor());
    expect(locked.statusCode).toBe(409);
    expect((await db.select().from(conversations).where(eq(conversations.id, conversationId)))[0].mode).toBe("human_ts");
    expect((await post(`/v1/conversations/${conversationId}/human-messages`, { ...creatorActor(), body: "let me in" })).statusCode).toBe(409);

    expect((await post(`/v1/conversations/${crypto.randomUUID()}/takeover`, creatorActor())).statusCode).toBe(404);
    expect((await post(`/v1/conversations/${conversationId}/takeover`, { actorId: crypto.randomUUID(), side: "creator" })).statusCode).toBe(400);
  });

  test("hand-back lets the AI answer again", async () => {
    const fanId = crypto.randomUUID();
    const { conversationId } = (await send(fanId, "hey juno")).json();
    await s.app.idle();
    await post(`/v1/conversations/${conversationId}/takeover`, creatorActor());
    await send(fanId, "hello?");
    await s.app.idle();
    const held = (await ai(conversationId)).length;

    expect((await post(`/v1/conversations/${conversationId}/hand-back`)).statusCode).toBe(204);
    expect((await db.select().from(conversations).where(eq(conversations.id, conversationId)))[0].mode).toBe("ai");
    await send(fanId, "ok i'm back");
    await s.app.idle();
    expect((await ai(conversationId)).length).toBeGreaterThan(held);
    expect((await post(`/v1/conversations/${crypto.randomUUID()}/hand-back`)).statusCode).toBe(404);
  });
});

describe("webhook", () => {
  test("a webhook endpoint that hangs does not hold the turn or the stream", async () => {
    let hits = 0;
    const hang: Server = createServer(() => {
      hits++; // never answers
    });
    await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
    const port = (hang.address() as { port: number }).port;
    const hooked = await testServer({ listen: true, env: { WEBHOOK_URL: `http://127.0.0.1:${port}/in`, WEBHOOK_SECRET: "shh" } });
    try {
      const fanId = crypto.randomUUID();
      const conv = await makeConversation(hooked.creatorId, fanId);
      const got: string[] = [];
      const ctl = new AbortController();
      void fetch(`${hooked.url}/v1/conversations/${conv.id}/events`, { headers: auth, signal: ctl.signal })
        .then(async (res) => {
          const reader = res.body!.getReader();
          const dec = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            got.push(dec.decode(value));
          }
        })
        .catch(() => undefined);
      const started = Date.now();
      const res = await hooked.app.inject({ method: "POST", url: "/v1/messages", headers: auth, payload: { creatorId: hooked.creatorId, fanId, body: "hey juno", clientMsgId: crypto.randomUUID() } });
      expect(res.statusCode).toBe(202);
      await hooked.app.idle();
      await vi.waitFor(() => expect(got.join("").includes("event: message")).toBe(true), { timeout: 4000, interval: 25 });
      expect(Date.now() - started).toBeLessThan(4000);
      expect((await db.select().from(messages).where(eq(messages.conversationId, conv.id))).some((m) => m.sender === "ai")).toBe(true);
      expect(hits).toBeGreaterThan(0);
      ctl.abort();
    } finally {
      await hooked.close();
      hang.closeAllConnections();
      await new Promise<void>((r) => hang.close(() => r()));
    }
  }, 30_000);
});
