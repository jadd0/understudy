import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { normalise } from "../normalise.mjs";
import { NotOwnAccount } from "../scrape/whoami.mjs";
import { exportToRaw, fixText, openExport, readInstagramExport } from "./instagram-export.mjs";
import { writeZip } from "./test-zip.mjs";

const FIXTURE = new URL("../../fixtures/instagram-export/", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "ig-export-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const NOW = () => new Date("2026-03-01T09:00:00Z");

function filesUnder(root, rel = "") {
  return readdirSync(join(root, rel), { withFileTypes: true }).flatMap((entry) => {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesUnder(root, next) : [next];
  });
}

function zipOf(folder, file) {
  writeZip(file, filesUnder(folder).map((name) => ({ name, data: readFileSync(join(folder, name)), method: name.endsWith(".json") ? 8 : 0 })));
  return file;
}

function copyFixture(name, mutate = () => {}) {
  const dir = join(scratch, name);
  cpSync(FIXTURE, dir, { recursive: true });
  mutate(dir);
  return dir;
}

function readRaw(dir) {
  return Object.fromEntries(filesUnder(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")]));
}

test("fixText repairs Latin-1 reads of UTF-8 and leaves everything else alone", () => {
  assert.equal(fixText("cafÃ©"), "café");
  assert.equal(fixText("hi ð\u009f\u0098\u008a"), "hi \u{1F60A}");
  assert.equal(fixText("  already fine \u{1F60A}  "), "already fine \u{1F60A}");
  // A lone accented letter is not a UTF-8 sequence, so it stays.
  assert.equal(fixText("café"), "café");
  // An invalid sequence stays as it was.
  assert.equal(fixText("aÃb"), "aÃb");
  // Text that already holds a character past U+00FF is never re-packed.
  assert.equal(fixText("Ã© \u{1F60A}"), "Ã© \u{1F60A}");
  assert.equal(fixText("plain"), "plain");
});

test("the folder and a zip of it give byte-identical raw output", () => {
  const zip = zipOf(FIXTURE, join(scratch, "fixture.zip"));
  const fromFolder = exportToRaw({ input: FIXTURE, rawRoot: join(scratch, "raw-folder"), now: NOW });
  const fromZip = exportToRaw({ input: zip, rawRoot: join(scratch, "raw-zip"), now: NOW });
  const a = readRaw(join(scratch, "raw-folder"));
  const b = readRaw(join(scratch, "raw-zip"));
  assert.deepEqual(Object.keys(a).sort(), ["wren.fixture/NOTES.md", "wren.fixture/posts.jsonl", "wren.fixture/profile.json"]);
  assert.deepEqual(a, b);
  assert.deepEqual(fromFolder.counts, fromZip.counts);
});

test("the raw layout holds the posts, her own comments and the repaired caption", () => {
  const out = join(scratch, "raw-layout");
  const result = exportToRaw({ input: FIXTURE, rawRoot: out, handle: "Wren.Fixture", now: NOW });
  assert.equal(result.username, "wren.fixture");
  assert.deepEqual(result.counts, { posts: 5, comments: 5, gif: 1, other_accounts: 2, duplicates: 0 });

  const posts = readFileSync(join(out, "wren.fixture", "posts.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(posts.map((p) => [p.shortcode, p.type]), [
    ["exp_1001", "photo"], ["exp_1002", "photo"], ["exp_1003", "carousel"], ["exp_1004", "video"], ["exp_1005", "reel"],
  ]);
  assert.equal(posts[1].caption, "café by the pier \u{1F60A}");
  assert.deepEqual(posts[4].hashtags, ["pier"]);
  assert.ok(posts.every((p) => p.url === null && p.found_in === "export" && p.post_owner === "wren.fixture"));

  const comments = posts.flatMap((p) => p.her_comments.map((c) => ({ shortcode: p.shortcode, ...c })));
  assert.equal(comments.length, 5);
  assert.ok(comments.every((c) => c.kind === "top_level" && !("replying_to_text" in c) && !("replying_to_user" in c)));
  // The comment before every post attaches to the earliest; the rest to the latest post at or before them.
  assert.deepEqual(comments.map((c) => c.shortcode), ["exp_1001", "exp_1002", "exp_1003", "exp_1003", "exp_1005"]);
  const gifs = comments.filter((c) => c.non_text);
  assert.equal(gifs.length, 1);
  assert.equal(gifs[0].text, "");

  const profile = JSON.parse(readFileSync(join(out, "wren.fixture", "profile.json"), "utf8"));
  assert.equal(profile.display_name, "Wren Fixture");
  assert.equal(profile.followers, null);
  assert.equal(profile.captured_at, "2026-03-01");
  const notes = readFileSync(join(out, "wren.fixture", "NOTES.md"), "utf8");
  assert.match(notes, /Comments on other accounts' posts, dropped \| 2/);
});

test("normalise accepts the output and every comment stays unpaired", () => {
  const raw = join(scratch, "raw-normalise");
  exportToRaw({ input: FIXTURE, rawRoot: raw, now: NOW });
  const bank = join(scratch, "bank-normalise");
  const { captions, replies, counts } = normalise({ rawDir: raw, outDir: bank, creator: "wren.fixture" });
  assert.equal(captions.length, 5);
  assert.equal(replies.length, 5);
  assert.equal(counts.replies_exact, 0);
  assert.equal(counts.top_level_comments, 5);
});

test("direct messages are never opened and never appear in the output", () => {
  assert.ok(filesUnder(FIXTURE).some((n) => n.startsWith("messages/")), "the fixture holds a DM thread");
  assert.ok(openExport(FIXTURE).names.every((n) => !n.startsWith("messages/")), "the reader never lists it");
  const data = readInstagramExport(FIXTURE);
  assert.ok(data.filesRead.length > 0);
  assert.ok(data.filesRead.every((name) => !name.startsWith("messages/")), data.filesRead.join(", "));
  const out = join(scratch, "raw-dm");
  exportToRaw({ input: zipOf(FIXTURE, join(scratch, "dm.zip")), rawRoot: out, now: NOW });
  for (const text of Object.values(readRaw(out))) assert.doesNotMatch(text, /private dm text/);
});

test("the posts file is found under content/ and your_instagram_activity/content/", () => {
  for (const [name, placement] of [["plain-content", "content/posts_1.json"], ["activity-content", "your_instagram_activity/content/posts_1.json"]]) {
    const dir = copyFixture(name, (root) => {
      mkdirSync(join(root, placement, ".."), { recursive: true });
      cpSync(join(root, "media/posts_1.json"), join(root, placement));
      rmSync(join(root, "media/posts_1.json"));
    });
    assert.equal(readInstagramExport(dir).posts.length, 5, placement);
  }
});

test("an HTML-only export, a missing profile and missing posts are refused with what to do", () => {
  const html = join(scratch, "html");
  mkdirSync(html, { recursive: true });
  writeFileSync(join(html, "index.html"), "<html></html>");
  assert.throws(() => readInstagramExport(html), /HTML format.*JSON/);

  const noProfile = copyFixture("no-profile", (root) => rmSync(join(root, "personal_information"), { recursive: true }));
  assert.throws(() => readInstagramExport(noProfile), /no personal_information/);

  const noPosts = copyFixture("no-posts", (root) => {
    rmSync(join(root, "media"), { recursive: true });
  });
  assert.throws(() => readInstagramExport(noPosts), /no posts file.*several parts/);
});

test("a handle that is not the export's account is refused and nothing is written", () => {
  const out = join(scratch, "raw-mismatch");
  assert.throws(() => exportToRaw({ input: FIXTURE, rawRoot: out, handle: "someone.else", now: NOW }), (error) => {
    assert.ok(error instanceof NotOwnAccount);
    assert.match(error.message, /^the export belongs to @wren\.fixture; refusing @someone\.else$/);
    return true;
  });
  assert.throws(() => statSync(out), /ENOENT/);
});

test("a username that could leave the output root is refused", () => {
  for (const [index, name] of ["../escape", "..", "a/b"].entries()) {
    const evil = copyFixture(`evil-name-${index}`, (root) => {
      const file = join(root, "personal_information/personal_information/personal_information.json");
      writeFileSync(file, readFileSync(file, "utf8").replace("wren.fixture", name));
    });
    assert.throws(() => readInstagramExport(evil), /no username/, name);
  }
});

test("a symlink in a folder export is not followed", () => {
  const dir = copyFixture("symlink", (root) => {
    const target = join(scratch, "outside.json");
    writeFileSync(target, "{}");
    symlinkSync(target, join(root, "media/linked.json"));
  });
  assert.ok(!openExport(dir).names.includes("media/linked.json"));
});

test("two posts whose first files share a digit group both survive, the later one numbered", () => {
  const dir = copyFixture("collision", (root) => {
    const file = join(root, "media/posts_1.json");
    const posts = JSON.parse(readFileSync(file, "utf8"));
    posts.push(
      { media: [{ uri: "media/posts/202404/1001_x_n.jpg", creation_timestamp: 1711900000, title: "same digits again" }] },
      { media: [{ uri: "media/posts/202405/1001_y_n.jpg", creation_timestamp: 1714500000, title: "and a third" }] },
    );
    writeFileSync(file, JSON.stringify(posts));
  });
  const { posts } = readInstagramExport(dir);
  assert.equal(posts.length, 7);
  const codes = posts.map((p) => p.shortcode);
  assert.equal(new Set(codes).size, 7);
  assert.deepEqual(codes.filter((c) => c.startsWith("exp_1001")), ["exp_1001", "exp_1001_2", "exp_1001_3"]);
  assert.deepEqual(posts.filter((p) => p.shortcode.startsWith("exp_1001")).map((p) => p.caption), [
    "first light on the pier before anyone else was awake", "same digits again", "and a third",
  ]);
});

test("a lookalike comments or posts file under messages/ is never listed or read, in a folder or a zip", () => {
  const canary = (root) => {
    const decoy = join(root, "messages/inbox/mothfan_1/comments");
    mkdirSync(decoy, { recursive: true });
    writeFileSync(
      join(decoy, "post_comments_1.json"),
      JSON.stringify([{ string_map_data: { Comment: { value: "CANARY dm text" }, "Media Owner": { value: "wren.fixture" }, Time: { timestamp: 1709400000 } } }]),
    );
    const media = join(root, "messages/inbox/mothfan_1/media");
    mkdirSync(media, { recursive: true });
    writeFileSync(join(media, "posts_1.json"), JSON.stringify([{ media: [{ uri: "media/posts/9999_z.jpg", creation_timestamp: 1709400000, title: "CANARY dm post" }] }]));
  };
  const dir = copyFixture("messages-canary", canary);
  assert.ok(filesUnder(dir).includes("messages/inbox/mothfan_1/comments/post_comments_1.json"), "the canary exists on disk");
  const zip = zipOf(dir, join(scratch, "canary.zip"));
  for (const input of [dir, zip]) {
    const archive = openExport(input);
    assert.ok(archive.names.length > 0 && archive.names.every((n) => !n.split("/").includes("messages")), input);
    const data = readInstagramExport(input);
    assert.ok(data.filesRead.length > 0);
    assert.ok(data.filesRead.every((n) => !n.split("/").includes("messages")), data.filesRead.join(", "));
    assert.equal(data.posts.length, 5);
    assert.equal(data.comments.length, 7);
    assert.ok(![...data.posts.map((p) => p.caption), ...data.comments.map((c) => c.text)].some((t) => t.includes("CANARY")));
  }
});

test("a comment lands on the latest post at or before it, and one before every post on the earliest", () => {
  const dir = copyFixture("attribution", (root) => {
    const file = join(root, "comments/post_comments_1.json");
    const at = (value, timestamp) => ({ string_map_data: { Comment: { value }, "Media Owner": { value: "wren.fixture" }, Time: { timestamp } } });
    // Post 1001 is at 1704110400 and 1002 at 1706788800: a comment on each post's own second and one just before 1002.
    writeFileSync(file, JSON.stringify([at("before all", 1), at("on first", 1704110400), at("just before second", 1706788799), at("on second", 1706788800)]));
  });
  const out = join(scratch, "raw-attribution");
  exportToRaw({ input: dir, rawRoot: out, now: NOW });
  const posts = readFileSync(join(out, "wren.fixture", "posts.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const placed = posts.flatMap((p) => p.her_comments.map((c) => [p.shortcode, c.text]));
  assert.deepEqual(placed.filter(([, text]) => /before all|on first|just before second|on second/.test(text)), [
    ["exp_1001", "before all"], ["exp_1001", "on first"], ["exp_1001", "just before second"], ["exp_1002", "on second"],
  ]);
});
