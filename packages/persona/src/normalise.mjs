// raw scrape -> anonymised bank: captions.jsonl, replies.jsonl, profile.json, normalise.meta.json.
//
// Raw layout: <rawDir>/<handle>/{posts.jsonl, profile.json}, one directory per account the
// creator owns. Every directory name counts as one of the creator's own handles.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { anonymiseText, ownHandleSet } from "./lib/anonymise.mjs";
import { isMain, parseArgs, readJson, readJsonl, sha16, writeJson, writeJsonl } from "./lib/io.mjs";

// The scrape records how it matched a reply to the comment it answered.
const BASIS = { replied_to_comment_id: "exact", thread_root: "thread_first" };

export function listHandles(rawDir) {
  return readdirSync(rawDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(rawDir, entry.name, "posts.jsonl")))
    .map((entry) => entry.name)
    .sort();
}

function dateOnly(iso) {
  return typeof iso === "string" ? iso.slice(0, 10) : null;
}

export function normalise({ rawDir, outDir, creator }) {
  const handles = listHandles(rawDir);
  if (!handles.includes(creator)) throw new Error(`creator directory missing under raw: ${creator}`);
  const own = ownHandleSet(handles);

  const captions = [];
  const replies = [];
  const counts = {
    posts_in: 0,
    posts_kept: 0,
    skipped_no_caption_no_replies: 0,
    captions_voice: 0,
    captions_not_voice: 0,
    collab_captions: 0,
    replies: 0,
    replies_text: 0,
    replies_non_text: 0,
    replies_exact: 0,
    replies_thread_first: 0,
    top_level_comments: 0,
  };
  const usedIds = new Set();

  for (const handle of handles) {
    const posts = readJsonl(join(rawDir, handle, "posts.jsonl"));
    for (const post of posts) {
      counts.posts_in++;
      const caption = typeof post.caption === "string" ? post.caption.trim() : "";
      const herComments = Array.isArray(post.her_comments) ? post.her_comments : [];
      if (caption === "" && herComments.length === 0) {
        counts.skipped_no_caption_no_replies++;
        continue;
      }
      counts.posts_kept++;

      // A caption written by another account (collab owned elsewhere) is a fact about the
      // creator, not her voice.
      const collab =
        Boolean(post.caption_author_note) ||
        (typeof post.post_owner === "string" && !own.has(post.post_owner.toLowerCase()));
      const voice = caption !== "" && !collab;
      if (collab) counts.collab_captions++;
      if (voice) counts.captions_voice++;
      else counts.captions_not_voice++;

      captions.push({
        id: post.shortcode,
        account: handle,
        source_url: post.url,
        type: post.type,
        date: dateOnly(post.date),
        caption: anonymiseText(caption, own),
        voice,
        collab,
        pinned: post.pinned === true,
        hashtags: Array.isArray(post.hashtags) ? post.hashtags : [],
        location: post.location ?? null,
        description: anonymiseText(post.description ?? "", own),
        play_count: post.play_count ?? null,
      });

      for (const comment of herComments) {
        counts.replies++;
        const nonText = comment.non_text === true || !comment.text;
        const kind = comment.kind === "reply" ? "reply" : "top_level";
        if (kind === "top_level") counts.top_level_comments++;
        if (nonText) counts.replies_non_text++;
        else counts.replies_text++;
        const basis = kind === "reply" ? (BASIS[comment.replying_to_basis] ?? "thread_first") : "none";
        if (basis === "exact") counts.replies_exact++;
        if (basis === "thread_first") counts.replies_thread_first++;

        const text = nonText ? "" : anonymiseText(comment.text, own);
        let id = sha16(`${post.shortcode}${comment.date}${text}`);
        // Two GIF replies in the same second share shortcode, date and (empty) text.
        for (let n = 2; usedIds.has(id); n++) id = sha16(`${post.shortcode}${comment.date}${text}#${n}`);
        usedIds.add(id);

        replies.push({
          id,
          post_shortcode: post.shortcode,
          date: comment.date,
          kind,
          text,
          non_text: nonText,
          replying_to: kind === "reply" ? anonymiseText(comment.replying_to_text ?? "", own) : null,
          replying_to_non_text: comment.replying_to_non_text ? true : false,
          replying_to_basis: basis,
        });
      }
    }
  }

  captions.sort((a, b) => (a.date + a.id < b.date + b.id ? -1 : 1));
  replies.sort((a, b) => (a.date + a.id < b.date + b.id ? -1 : 1));

  const profile = normaliseProfile(rawDir, creator, own);

  writeJsonl(join(outDir, "captions.jsonl"), captions);
  writeJsonl(join(outDir, "replies.jsonl"), replies);
  writeJson(join(outDir, "profile.json"), profile);
  writeJson(join(outDir, "normalise.meta.json"), { creator, handles, counts });
  return { captions, replies, profile, counts };
}

function normaliseProfile(rawDir, creator, own) {
  const raw = readJson(join(rawDir, creator, "profile.json"));
  return {
    handle: raw.handle,
    display_name: raw.display_name ?? null,
    category: raw.category ?? null,
    // Contact details never enter the bank: the persona must not share them.
    bio: anonymiseText(raw.bio ?? "", own).replace(/\n?\[email\]/g, ""),
    links: (raw.links ?? []).map((link) => ({ text: anonymiseText(link.text, own), url: anonymiseText(link.url, own) })),
    followers: raw.followers ?? null,
    following: raw.following ?? null,
    posts: raw.posts ?? null,
    captured_at: raw.captured_at ?? null,
  };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const creator = args.creator;
  if (typeof creator !== "string") throw new Error("--creator <handle> is required");
  const result = normalise({
    rawDir: args.raw ?? "data/persona/raw",
    outDir: args.out ?? "data/persona/bank",
    creator,
  });
  console.log(JSON.stringify(result.counts));
}
