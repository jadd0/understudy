// Reads Instagram's own data download (a zip or the folder it unpacks to) into the raw layout
// normalise.mjs reads:  <rawRoot>/<username>/{posts.jsonl, profile.json, NOTES.md}
//
// The download belongs to one account, so the account is the export's own `Username`. Only the
// profile, the account's posts and reels, and the comments it wrote are read. Direct messages,
// stories and likes are listed in the archive but never opened.
import { lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { sha16, writeJson } from "../lib/io.mjs";
import { isoSeconds, tagsOf } from "../scrape/record.mjs";
import { NotOwnAccount } from "../scrape/whoami.mjs";
import { EXPORT_ENTRY_MAX_BYTES, openZip } from "./zip.mjs";

/** A download that cannot be used, with what to do about it. */
export class ExportError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExportError";
  }
}

const HANDLE = /^[A-Za-z0-9._]{1,30}$/;
// The committed synthetic creators. An export never writes over them.
const SYNTHETIC = ["junovale", "junofilm"];

const PROFILE_FILE = /(^|\/)personal_information\.json$/;
const POSTS_FILE = /(^|\/)(content|media)\/posts(_\d+)?\.json$/;
const REELS_FILE = /(^|\/)(content|media)\/reels\.json$/;
const COMMENTS_FILE = /(^|\/)comments\/(post_comments(_\d+)?|reels_comments)\.json$/;

/**
 * Instagram writes UTF-8 bytes as if each were a Latin-1 character ("é" arrives as "Ã©"). When every
 * character is below U+0100 and at least one is in U+0080 to U+00FF, the text is re-read as bytes and
 * decoded as UTF-8; text that does not decode, or that already holds a character past U+00FF, is kept.
 */
export function fixText(value) {
  const text = String(value ?? "");
  let high = false;
  let latin = false;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x100) high = true;
    else if (code >= 0x80) latin = true;
  }
  if (high || !latin) return text.trim();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(text, (ch) => ch.codePointAt(0))).trim();
  } catch {
    return text.trim();
  }
}

function walkFolder(root) {
  const names = [];
  const pending = [""];
  while (pending.length) {
    const rel = pending.pop();
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      // A symlink is never followed: it could point anywhere on the disk.
      if (entry.isSymbolicLink()) continue;
      const next = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) pending.push(next);
      else if (entry.isFile()) names.push(next);
    }
  }
  return names.sort();
}

/** Opens a zip or an unpacked folder. `reads` lists every file whose contents were opened. */
export function openExport(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new ExportError("the export path does not exist or cannot be read");
  }
  const reads = [];
  let names;
  let readBuffer;
  let close = () => {};
  if (stat.isDirectory()) {
    names = walkFolder(path);
    const listed = new Set(names);
    readBuffer = (name) => {
      if (!listed.has(name)) throw new ExportError(`no file named ${JSON.stringify(name)} in the export`);
      const full = join(path, ...name.split("/"));
      const info = lstatSync(full);
      if (!info.isFile() || info.size > EXPORT_ENTRY_MAX_BYTES) throw new ExportError(`${JSON.stringify(name)} is not a readable file of a safe size`);
      return readFileSync(full);
    };
  } else {
    const zip = openZip(path);
    names = [...zip.names].sort();
    readBuffer = (name) => zip.read(name);
    close = () => zip.close();
  }
  return {
    names,
    reads,
    readJson(name) {
      reads.push(name);
      try {
        return JSON.parse(readBuffer(name).toString("utf8"));
      } catch (error) {
        if (error instanceof SyntaxError) throw new ExportError(`${JSON.stringify(name)} is not valid JSON`);
        throw error;
      }
    },
    close,
  };
}

/** A file is a bare list or an object holding one list under a single key. */
function listOf(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") return Object.values(json).find(Array.isArray) ?? [];
  return [];
}

const stringOf = (field) => (typeof field?.value === "string" ? field.value : "");

function mediaOf(entry) {
  if (Array.isArray(entry?.media)) return entry.media;
  const labelled = Array.isArray(entry?.label_values) ? entry.label_values.find((item) => item?.label === "Media") : null;
  return Array.isArray(labelled?.media) ? labelled.media : [];
}

function postFrom(entry, { reel, used }) {
  const media = mediaOf(entry);
  if (media.length === 0 || typeof media[0]?.uri !== "string") return null;
  const time = [media[0].creation_timestamp, entry.creation_timestamp, entry.timestamp].find((t) => Number.isFinite(t));
  if (time === undefined) return null;
  const uri = media[0].uri;
  const digits = /^(\d+)_/.exec(basename(uri))?.[1];
  let shortcode = digits ? `exp_${digits}` : `exp_${sha16(uri)}`;
  if (used.has(shortcode)) return null;
  used.add(shortcode);
  const type = reel ? "reel" : media.length > 1 ? "carousel" : /\.mp4$/i.test(uri) ? "video" : "photo";
  return { shortcode, type, time, caption: fixText(media[0].title || entry.title || "") };
}

function commentFrom(entry) {
  const fields = entry?.string_map_data ?? {};
  const time = fields.Time?.timestamp;
  if (!Number.isFinite(time)) return null;
  const owner = fixText(stringOf(fields["Media Owner"]));
  const text = fixText(stringOf(fields.Comment));
  const gif = text === "" && Array.isArray(entry.media_list_data) && entry.media_list_data.length > 0;
  if (text === "" && !gif) return null;
  return { owner, text, time, nonText: gif };
}

/**
 * Reads the profile, posts and the comments the account wrote. Returns plain data; writes nothing.
 * @param {string} path a zip or an unpacked folder
 */
export function readInstagramExport(path) {
  const archive = openExport(path);
  try {
    const { names } = archive;
    if (!names.some((n) => n.endsWith(".json")) && names.some((n) => n.endsWith(".html"))) {
      throw new ExportError("this export is in HTML format: request the download again and choose JSON as the format");
    }
    const profileName = names.find((n) => PROFILE_FILE.test(n));
    if (!profileName) throw new ExportError("the export has no personal_information file: it is not an Instagram JSON download");
    const info = archive.readJson(profileName).profile_user?.[0];
    const fields = info?.string_map_data ?? {};
    const username = stringOf(fields.Username).trim();
    if (!HANDLE.test(username) || /^\.+$/.test(username)) throw new ExportError("the export's personal_information file has no username");

    const postFiles = names.filter((n) => POSTS_FILE.test(n));
    const reelFiles = names.filter((n) => REELS_FILE.test(n));
    if (postFiles.length + reelFiles.length === 0) {
      throw new ExportError("the export has no posts file: if the download came in several parts, merge them into one folder and pass the folder");
    }
    const used = new Set();
    const posts = [];
    for (const [files, reel] of [[postFiles, false], [reelFiles, true]]) {
      for (const name of files) {
        for (const entry of listOf(archive.readJson(name))) {
          const post = postFrom(entry, { reel, used });
          if (post) posts.push(post);
        }
      }
    }
    if (posts.length === 0) throw new ExportError("the export holds no posts");

    const comments = [];
    for (const name of names.filter((n) => COMMENTS_FILE.test(n))) {
      for (const entry of listOf(archive.readJson(name))) {
        const comment = commentFrom(entry);
        if (comment) comments.push(comment);
      }
    }

    return {
      profile: {
        username,
        name: fixText(stringOf(fields.Name)),
        biography: fixText(stringOf(fields.Biography)),
        website: fixText(stringOf(fields.Website)),
      },
      posts,
      comments,
      filesRead: [...archive.reads],
    };
  } finally {
    archive.close();
  }
}

function renderNotes({ username, capturedAt, counts }) {
  return [
    `# ${username}: export notes`,
    "",
    `Read ${capturedAt} from the account's own Instagram data download.`,
    "",
    "| | |",
    "|---|---|",
    `| Posts and reels | ${counts.posts} |`,
    `| Comments she wrote on her own posts | ${counts.comments} (${counts.gif} GIF or sticker) |`,
    `| Comments on other accounts' posts, dropped | ${counts.other_accounts} |`,
    `| Repeated comments, dropped | ${counts.duplicates} |`,
    "",
    "A download holds the comment she wrote but not the comment it answered, so none of her comments has a fan side.",
    "Direct messages, stories and likes are in the download and are never read.",
    "Image descriptions are left empty.",
    "",
  ].join("\n");
}

/**
 * Writes the raw layout for the export's own account. `handle`, when given, must be that account:
 * nothing is written for any other.
 */
export function exportToRaw({ input, rawRoot, handle, now = () => new Date() }) {
  const data = readInstagramExport(input);
  const { username } = data.profile;
  if (handle !== undefined && handle.toLowerCase() !== username.toLowerCase()) throw new NotOwnAccount(username, handle);
  if (SYNTHETIC.includes(username.toLowerCase())) {
    throw new ExportError(`refusing to write into a synthetic creator's directory (${SYNTHETIC.join(", ")})`);
  }

  const posts = data.posts.slice().sort((a, b) => a.time - b.time || (a.shortcode < b.shortcode ? -1 : 1));
  const records = posts.map((post, index) => ({
    index,
    url: null,
    shortcode: post.shortcode,
    type: post.type,
    date: isoSeconds(post.time),
    caption: post.caption,
    post_owner: username,
    found_in: "export",
    ...tagsOf(post.caption),
    tagged_users: [],
    collab_coauthors: [],
    location: null,
    play_count: null,
    description: "",
    her_comments: [],
  }));

  const counts = { posts: records.length, comments: 0, gif: 0, other_accounts: 0, duplicates: 0 };
  const seen = new Set();
  const own = data.comments.filter((c) => c.owner.toLowerCase() === username.toLowerCase());
  counts.other_accounts = data.comments.length - own.length;
  for (const comment of own.sort((a, b) => a.time - b.time)) {
    const key = `${comment.time}|${comment.text}`;
    if (seen.has(key)) {
      counts.duplicates++;
      continue;
    }
    seen.add(key);
    // The post it was written under is not in the download: the latest post at or before the comment stands in.
    let target = records[0];
    for (const record of records) if (Date.parse(record.date) <= comment.time * 1000) target = record;
    target.her_comments.push({
      kind: "top_level",
      date: isoSeconds(comment.time),
      text: comment.nonText ? "" : comment.text,
      non_text: comment.nonText,
    });
    counts.comments++;
    if (comment.nonText) counts.gif++;
  }

  const capturedAt = now().toISOString().slice(0, 10);
  const dir = join(rawRoot, username);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "posts.jsonl"), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  writeJson(join(dir, "profile.json"), {
    handle: username,
    display_name: data.profile.name || username,
    category: null,
    bio: data.profile.biography,
    links: data.profile.website ? [{ text: data.profile.website, url: data.profile.website }] : [],
    followers: null,
    following: null,
    url: null,
    posts: records.length,
    captured_at: capturedAt,
  });
  writeFileSync(join(dir, "NOTES.md"), renderNotes({ username, capturedAt, counts }));
  return { dir, username, displayName: data.profile.name || username, counts, filesRead: data.filesRead };
}
