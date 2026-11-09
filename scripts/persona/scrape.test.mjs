import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ENDPOINTS, InstagramError, ORIGIN, createClient } from "./scrape/instagram.mjs";

const FIX = new URL("./fixtures/instagram/", import.meta.url).pathname;
const ROUTES = JSON.parse(readFileSync(`${FIX}routes.json`, "utf8"));
const SESSION = "SECRET-SESSION-VALUE";

/** A fetch that serves the recorded fixtures by URL and throws on anything else: no test reaches the network. */
function fakeFetch(log = [], overrides = {}) {
  return async (url, init) => {
    log.push({ url, init });
    const parsed = new URL(url);
    const key = parsed.pathname + parsed.search;
    if (overrides[key]) return overrides[key](url, init);
    const file = ROUTES[key];
    if (!file) throw new Error(`no fixture for ${key}`);
    const body = readFileSync(`${FIX}${file}.json`, "utf8");
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
}

const noSleep = async () => {};

test("the transport refuses a non-GET method before calling fetch", async () => {
  const log = [];
  const client = createClient({ fetch: fakeFetch(log), sessionId: SESSION, delayMs: 0, sleep: noSleep });
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "get", undefined]) {
    await assert.rejects(() => client.request(method, "/api/v1/media/1001/info/"), InstagramError);
  }
  assert.equal(log.length, 0);
  await client.get(ENDPOINTS.info("1001"));
  assert.equal(log.length, 1);
  assert.equal(log[0].init.method, "GET");
});

test("the cookie is sent only to www.instagram.com and never appears in thrown errors", async () => {
  const log = [];
  const client = createClient({ fetch: fakeFetch(log), sessionId: SESSION, delayMs: 0, sleep: noSleep });
  await client.get(ENDPOINTS.profile("fixturecreator"));
  assert.equal(new URL(log[0].url).origin, ORIGIN);
  assert.equal(log[0].init.headers.cookie, `sessionid=${SESSION}`);

  // Anything that could resolve to another host is refused before fetch.
  for (const path of ["https://evil.example/x", "//evil.example/x", "evil.example/x", "/\\evil.example"]) {
    await assert.rejects(() => client.get(path), (error) => {
      assert.ok(!String(error.message).includes(SESSION));
      return error instanceof InstagramError;
    });
  }
  assert.equal(log.length, 1);

  // A failing fetch whose own message quotes the cookie, and an error status, leak nothing.
  const failing = createClient({
    fetch: async () => {
      throw new TypeError(`connect failed with cookie sessionid=${SESSION}`);
    },
    sessionId: SESSION, delayMs: 0, sleep: noSleep,
  });
  await assert.rejects(() => failing.get(ENDPOINTS.info("1")), (error) => {
    assert.ok(!error.message.includes(SESSION) && !String(error.stack).includes(SESSION));
    return true;
  });
  for (const status of [401, 429]) {
    const refused = createClient({
      fetch: async () => new Response(`body mentioning ${SESSION}`, { status }),
      sessionId: SESSION, delayMs: 0, sleep: noSleep,
    });
    await assert.rejects(() => refused.get(ENDPOINTS.info("1")), (error) => {
      assert.equal(error.status, status);
      assert.ok(!error.message.includes(SESSION));
      return true;
    });
  }
});

test("the transport waits delayMs between requests, not before the first", async () => {
  const waits = [];
  const client = createClient({ fetch: fakeFetch(), sessionId: SESSION, delayMs: 7, sleep: async (ms) => void waits.push(ms) });
  await client.get(ENDPOINTS.info("1001"));
  await client.get(ENDPOINTS.info("1002"));
  assert.deepEqual(waits, [7]);
});

test("no request reaches the network: the fake fetch throws on any URL without a fixture", async () => {
  const client = createClient({ fetch: fakeFetch(), sessionId: SESSION, delayMs: 0, sleep: noSleep });
  await assert.rejects(() => client.get("/api/v1/media/999999/info/"), (error) => error instanceof InstagramError);
});
