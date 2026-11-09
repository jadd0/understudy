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

// ---- pairing and record mapping ----
import { pairReply } from "./scrape/pairing.mjs";
import { mapHerComment, mapPost, toThreadComment } from "./scrape/record.mjs";

const comment = (id, user, text, ts, extra = {}) => ({ id, user, text, ts, nonText: false, likes: 0, ...extra });

test("a reply that @-mentions an earlier thread commenter pairs exactly; one that does not pairs to the thread root", () => {
  const root = comment("r", "fan_a", "root text", 100);
  const child = comment("c1", "fan_b", "child text", 110);
  const thread = [root, child];
  const exactChild = pairReply({ reply: comment("x", "me", "@fan_b same", 120), thread: [...thread] });
  assert.equal(exactChild.basis, "replied_to_comment_id");
  assert.equal(exactChild.target.id, "c1");
  const exactRoot = pairReply({ reply: comment("x", "me", "@FAN_A hi", 120), thread });
  assert.equal(exactRoot.basis, "replied_to_comment_id");
  assert.equal(exactRoot.target.id, "r");
  for (const text of ["no mention at all", "hey @fan_b mid-text", "@nobody_here unknown handle", "@fan_b"]) {
    const reply = comment("x", "me", text, text === "@fan_b" ? 105 : 120);
    const paired = pairReply({ reply, thread });
    assert.equal(paired.basis, "thread_root", text);
    assert.equal(paired.target.id, "r", text);
  }
});

test("the latest earlier comment by the mentioned handle wins when there are several", () => {
  const thread = [
    comment("r", "fan_d", "first", 100),
    comment("c1", "fan_e", "other", 110),
    comment("c2", "fan_d", "second", 120),
    comment("c3", "fan_d", "after the reply", 300),
  ];
  const paired = pairReply({ reply: comment("x", "me", "@fan_d you too", 200), thread });
  assert.equal(paired.target.id, "c2");
  assert.equal(paired.basis, "replied_to_comment_id");
});

test("a GIF reply is non_text with empty text, and a GIF it answers is flagged", () => {
  const fanGif = toThreadComment({ pk: 1, text: "", created_at: 100, user: { username: "fan" }, giphy_media_info: { id: "g" } });
  const herGif = toThreadComment({ pk: 2, text: "", created_at: 110, user: { username: "me" }, giphy_media_info: { id: "g" }, comment_like_count: 3 });
  assert.equal(fanGif.nonText, true);
  const mapped = mapHerComment(herGif, pairReply({ reply: herGif, thread: [fanGif, herGif] }));
  assert.equal(mapped.non_text, true);
  assert.equal(mapped.text, "");
  assert.equal(mapped.replying_to_non_text, true);
  assert.equal(mapped.replying_to_text, "");
  assert.equal(mapped.replying_to_basis, "thread_root");
  assert.equal(mapped.likes, 3);
  // Empty text with no media is not a GIF.
  assert.equal(toThreadComment({ pk: 3, text: "", created_at: 1, user: { username: "x" } }).nonText, false);
});

test("a collab post owned by another account carries caption_author_note", () => {
  const item = JSON.parse(readFileSync(`${FIX}info-1003.json`, "utf8")).items[0];
  const record = mapPost(item, { handle: "fixturecreator", index: 2, userId: "9001" });
  assert.equal(record.post_owner, "otherhandle");
  assert.equal(record.caption_author_note, "collab post owned by @otherhandle; fixturecreator is a co-author");
  assert.deepEqual(record.collab_coauthors, ["fixturecreator"]);
  const own = mapPost(JSON.parse(readFileSync(`${FIX}info-1001.json`, "utf8")).items[0], { handle: "fixturecreator", index: 0, userId: "9001" });
  assert.equal("caption_author_note" in own, false);
  assert.equal(own.pinned, true);
  assert.deepEqual(own.hashtags, ["coffee", "fixture"]);
  assert.deepEqual(own.mentions, ["@friend_one"]);
  assert.deepEqual(own.tagged_users, ["tagged_pal"]);
  assert.equal(own.location, "Test Harbour");
  assert.equal(own.description, "");
});
