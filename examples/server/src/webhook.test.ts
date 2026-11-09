import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createWebhook, sign, SIGNATURE_HEADER } from "./webhook";

const respond = (status: number) => ({ ok: status >= 200 && status < 300, status }) as Response;

describe("webhook", () => {
  test("the signature is the HMAC of the raw body", async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const hook = createWebhook({
      url: "https://hooks.example.test/in",
      secret: "s3cret",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, headers: init.headers as Record<string, string>, body: init.body as string });
        return respond(200);
      }) as unknown as typeof fetch,
    });
    const event = { event: "message.delivered", conversationId: "c1", messageId: "m1" };
    expect(await hook.deliver(event)).toBe(true);
    expect(calls).toHaveLength(1);
    const expected = `sha256=${createHmac("sha256", "s3cret").update(calls[0].body).digest("hex")}`;
    expect(calls[0].headers[SIGNATURE_HEADER]).toBe(expected);
    expect(calls[0].headers[SIGNATURE_HEADER]).toBe(sign(JSON.stringify(event), "s3cret"));
    expect(JSON.parse(calls[0].body)).toEqual(event);
    expect(sign("x", "other")).not.toBe(sign("x", "s3cret"));
  });

  test("a 500 is retried 3 times then dropped without throwing", async () => {
    let calls = 0;
    const logs: string[] = [];
    const hook = createWebhook({
      url: "https://hooks.example.test/in",
      secret: "s",
      backoffMs: () => 0,
      log: (l) => logs.push(l),
      fetch: (async () => {
        calls++;
        return respond(500);
      }) as unknown as typeof fetch,
    });
    await expect(hook.deliver({ event: "x" })).resolves.toBe(false);
    expect(calls).toBe(3);
    // fire-and-forget never throws into the caller either
    expect(() => hook.send({ event: "y" })).not.toThrow();
    await hook.idle();
    expect(calls).toBe(6);
    expect(logs.every((l) => !l.includes("hooks.example.test"))).toBe(true);
  });

  test("a network error is retried and logged by class only", async () => {
    let calls = 0;
    const logs: string[] = [];
    const hook = createWebhook({
      url: "https://hooks.example.test/in",
      secret: "s",
      backoffMs: () => 0,
      log: (l) => logs.push(l),
      fetch: (async () => {
        calls++;
        throw new TypeError("connect ECONNREFUSED 10.0.0.1");
      }) as unknown as typeof fetch,
    });
    await expect(hook.deliver({ event: "x" })).resolves.toBe(false);
    expect(calls).toBe(3);
    expect(logs).toHaveLength(3);
    expect(logs.some((l) => l.includes("10.0.0.1"))).toBe(false);
    expect(logs[0]).toContain("TypeError");
  });
});
