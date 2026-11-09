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

test("a period straight after the mention is punctuation, not part of the handle", () => {
  const thread = [comment("r", "fan_a", "root text", 100), comment("c1", "maddie.skates", "child", 110)];
  const plain = pairReply({ reply: comment("x", "me", "@fan_a. thank you", 120), thread });
  assert.equal(plain.basis, "replied_to_comment_id");
  assert.equal(plain.target.id, "r");
  const dotted = pairReply({ reply: comment("y", "me", "@maddie.skates. ha", 120), thread });
  assert.equal(dotted.target.id, "c1");
});

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

// ---- the collection loop and the CLI ----
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonl } from "./lib/io.mjs";
import { normalise } from "./normalise.mjs";
import { main, scrape } from "./scrape/scrape.mjs";

const NOW = () => new Date("2026-06-01T12:00:00Z");
const scrapeFixture = async ({ fetch = fakeFetch(), caps, out = mkdtempSync(join(tmpdir(), "scrape-")), maxPosts } = {}) => {
  const client = createClient({ fetch, sessionId: SESSION, delayMs: 0, sleep: noSleep });
  const result = await scrape({ client, handle: "fixturecreator", out, caps, maxPosts, now: NOW });
  return { out, ...result, posts: readJsonl(join(out, "fixturecreator", "posts.jsonl")) };
};

test("a fixture account scrapes into the raw layout and normalise accepts it unchanged", async () => {
  const { out, posts, counts } = await scrapeFixture();
  assert.deepEqual(readdirSync(join(out, "fixturecreator")).sort(), ["NOTES.md", "posts.jsonl", "profile.json"]);
  assert.deepEqual(posts.map((p) => p.shortcode), ["FIX1", "FIX2", "FIX3", "FIX4"]);
  assert.deepEqual(posts.map((p) => p.index), [0, 1, 2, 3]);
  const expectedKeys = ["index", "url", "shortcode", "type", "date", "caption", "post_owner", "pinned", "found_in", "hashtags", "mentions", "tagged_users",
    "collab_coauthors", "location", "like_count", "comment_count", "play_count", "description", "her_comments", "comment_scan"];
  for (const post of posts) {
    const missing = expectedKeys.filter((key) => !(key in post));
    assert.deepEqual(missing, [], post.shortcode);
  }
  assert.deepEqual(posts.map((p) => p.type), ["photo", "reel", "carousel", "photo"]);
  assert.deepEqual(counts, { posts: 4, capped: 0, replies: 8, exact: 4, threadRoot: 4, topLevel: 1, nonText: 2 });

  const bank = mkdtempSync(join(tmpdir(), "scrape-bank-"));
  const result = normalise({ rawDir: out, outDir: bank, creator: "fixturecreator" });
  assert.deepEqual(result.counts, {
    posts_in: 4, posts_kept: 3, skipped_no_caption_no_replies: 1, captions_voice: 2, captions_not_voice: 1, collab_captions: 1,
    replies: 9, replies_text: 7, replies_non_text: 2, replies_exact: 4, replies_thread_first: 4, top_level_comments: 1,
  });
  assert.equal(result.profile.handle, "fixturecreator");
  const gif = result.replies.filter((r) => r.non_text);
  assert.equal(gif.length, 2);
  assert.ok(gif.every((r) => r.text === "" && r.replying_to_non_text === true));
  const collab = result.captions.find((c) => c.id === "FIX3");
  assert.deepEqual([collab.voice, collab.collab], [false, true]);
});

test("pagination follows the cursor until the cap, and a capped post is marked more_left_unscanned", async () => {
  const log = [];
  const full = await scrapeFixture({ fetch: fakeFetch(log) });
  const first = full.posts.find((p) => p.shortcode === "FIX1");
  assert.deepEqual(first.comment_scan, { pages: 2, top_level_comments_seen: 5, more_left_unscanned: false, reply_threads_expanded: 4 });
  assert.ok(log.some((r) => r.url.includes("min_id=p1cursor2")));
  assert.ok(log.some((r) => r.url.includes("max_id=feedcursor2")));

  const capped = await scrapeFixture({ caps: { maxCommentPages: 1 } });
  const post = capped.posts.find((p) => p.shortcode === "FIX1");
  assert.deepEqual(post.comment_scan, { pages: 1, top_level_comments_seen: 3, more_left_unscanned: true, reply_threads_expanded: 3 });
  assert.equal(capped.counts.capped, 1);
  assert.match(readFileSync(join(capped.out, "fixturecreator", "NOTES.md"), "utf8"), /hit a scan cap \(more_left_unscanned\) \| 1 \|/);

  const fewThreads = await scrapeFixture({ caps: { maxThreads: 1 } });
  assert.equal(fewThreads.posts.find((p) => p.shortcode === "FIX1").comment_scan.more_left_unscanned, true);
  assert.equal(fewThreads.posts.find((p) => p.shortcode === "FIX4").comment_scan.more_left_unscanned, false);
});

test("a repeating cursor stops the loop instead of looping forever", async () => {
  const requests = [];
  const loopFetch = fakeFetch(requests, {
    "/api/v1/media/1001/comments/?min_id=p1cursor2": async () =>
      new Response(JSON.stringify({ comments: [], has_more_comments: true, next_min_id: "p1cursor2" }), { status: 200 }),
  });
  const { posts } = await scrapeFixture({ fetch: loopFetch, maxPosts: 1, caps: { maxCommentPages: 1000 } });
  assert.equal(posts[0].comment_scan.more_left_unscanned, true);
  // First page, then the page that repeats its cursor: two fetches, not a thousand.
  assert.equal(requests.filter((r) => r.url.includes("/media/1001/comments/?")).length, 1);
  assert.equal(posts[0].comment_scan.pages, 2);
});

test("a 429 stops the run, keeps what was written, and records it in NOTES.md", async () => {
  const out = mkdtempSync(join(tmpdir(), "scrape-"));
  const limited = fakeFetch([], { "/api/v1/media/1003/info/": async () => new Response("slow down", { status: 429 }) });
  const client = createClient({ fetch: limited, sessionId: SESSION, delayMs: 0, sleep: noSleep });
  await assert.rejects(() => scrape({ client, handle: "fixturecreator", out, now: NOW }), (error) => error.status === 429);
  const kept = readJsonl(join(out, "fixturecreator", "posts.jsonl"));
  assert.deepEqual(kept.map((p) => p.shortcode), ["FIX1", "FIX2"]);
  const notes = readFileSync(join(out, "fixturecreator", "NOTES.md"), "utf8");
  assert.match(notes, /Incomplete/);
  assert.match(notes, /429/);
  assert.ok(!notes.includes(SESSION));
});

test("writing into a synthetic creator's directory is refused, before any request", async () => {
  const log = [];
  const client = createClient({ fetch: fakeFetch(log), sessionId: SESSION, delayMs: 0, sleep: noSleep });
  const out = mkdtempSync(join(tmpdir(), "scrape-"));
  for (const handle of ["junovale", "JunoFilm"]) {
    await assert.rejects(() => scrape({ client, handle, out, now: NOW }), /synthetic creator/);
    assert.equal(existsSync(join(out, handle)), false);
  }
  assert.equal(log.length, 0);
});

test("the CLI exits 1 naming IG_SESSIONID when it is missing, with no request made", async () => {
  const log = [];
  const errors = [];
  const code = await main({ argv: ["--handle", "fixturecreator", "--out", mkdtempSync(join(tmpdir(), "scrape-"))], env: {}, fetch: fakeFetch(log), stderr: (m) => errors.push(m) });
  assert.equal(code, 1);
  assert.equal(log.length, 0);
  assert.match(errors.join("\n"), /IG_SESSIONID/);
});

test("the CLI runs a fixture scrape, the cookie never reaches output, and --help prints the consent line", async () => {
  const out = mkdtempSync(join(tmpdir(), "scrape-"));
  const printed = [];
  const code = await main({
    argv: ["--handle", "fixturecreator", "--out", out, "--delay-ms", "0"],
    env: { IG_SESSIONID: SESSION }, fetch: fakeFetch(), sleep: noSleep, stdout: (m) => printed.push(m), stderr: (m) => printed.push(m), now: NOW,
  });
  assert.equal(code, 0);
  assert.ok(!printed.join("\n").includes(SESSION));
  for (const name of readdirSync(join(out, "fixturecreator"))) {
    assert.ok(!readFileSync(join(out, "fixturecreator", name), "utf8").includes(SESSION), name);
  }
  const help = execFileSync("node", [new URL("./scrape/scrape.mjs", import.meta.url).pathname, "--help"], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.match(help, /--handle/);
  assert.match(help, /you own or have written permission/);
});
