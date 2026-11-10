// Maps Instagram web API JSON to the raw record shape normalise.mjs reads
// (<out>/<handle>/{posts.jsonl, profile.json}). Pure: no network, no file access.

const HASHTAG = /#([\p{L}\p{N}_]+)/gu;
const MENTION = /@([A-Za-z0-9._]+)/g;

function unique(values) {
  return [...new Set(values)];
}

export function isoSeconds(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Hashtags and @mentions in a caption, each once, in order of appearance. */
export function tagsOf(caption) {
  return {
    hashtags: unique([...caption.matchAll(HASHTAG)].map((match) => match[1])),
    mentions: unique([...caption.matchAll(MENTION)].map((match) => `@${match[1]}`)),
  };
}

export function mapProfile(webProfile, { capturedAt }) {
  const user = webProfile?.data?.user;
  if (!user?.username || !user?.id) throw new Error("profile response has no user");
  return {
    handle: user.username,
    display_name: user.full_name || user.username,
    category: user.category_name ?? null,
    bio: user.biography ?? "",
    links: (user.bio_links ?? []).map((link) => ({ text: link.title ?? "", url: link.url })),
    followers: user.edge_followed_by?.count ?? null,
    following: user.edge_follow?.count ?? null,
    url: `https://www.instagram.com/${user.username}/`,
    posts: user.edge_owner_to_timeline_media?.count ?? null,
    captured_at: capturedAt,
  };
}

export function postType(item) {
  if (item.media_type === 8) return "carousel";
  if (item.media_type === 2) return item.product_type === "clips" ? "reel" : "video";
  return "photo";
}

/** The fields of a post record that come from the media item. her_comments and comment_scan are added by the loop. */
export function mapPost(item, { handle, index, userId }) {
  const caption = item.caption?.text ?? "";
  const owner = item.user?.username ?? handle;
  const coauthors = (item.coauthor_producers ?? []).map((user) => user.username);
  const record = {
    index,
    url: `https://www.instagram.com/p/${item.code}/`,
    shortcode: item.code,
    type: postType(item),
    date: isoSeconds(item.taken_at),
    caption,
    post_owner: owner,
  };
  if (owner.toLowerCase() !== handle.toLowerCase()) {
    record.caption_author_note = `collab post owned by @${owner}; ${handle} is a co-author`;
  }
  return {
    ...record,
    pinned: (item.timeline_pinned_user_ids ?? []).map(String).includes(String(userId)),
    found_in: "profile_grid",
    ...tagsOf(caption),
    tagged_users: (item.usertags?.in ?? []).map((tag) => tag.user.username),
    collab_coauthors: coauthors,
    location: item.location?.name ?? null,
    like_count: item.like_and_view_counts_disabled ? null : (item.like_count ?? null),
    comment_count: item.comment_count ?? null,
    play_count: item.play_count ?? item.view_count ?? null,
    description: "",
  };
}

/** A comment as pairing and mapping see it. GIFs and stickers carry media and no text. */
export function toThreadComment(raw) {
  const text = typeof raw.text === "string" ? raw.text : "";
  const hasMedia = Boolean(raw.giphy_media_info || raw.gif || raw.sticker);
  return {
    id: String(raw.pk),
    user: raw.user?.username ?? "",
    ts: raw.created_at,
    text,
    nonText: text.trim() === "" && hasMedia,
    likes: raw.comment_like_count ?? 0,
  };
}

/** One of the owner's comments. `pairing` is null for a top-level comment. */
export function mapHerComment(comment, pairing) {
  const nonText = comment.nonText;
  const record = {
    kind: pairing ? "reply" : "top_level",
    date: isoSeconds(comment.ts),
    text: nonText ? "" : comment.text,
    non_text: nonText,
  };
  if (!pairing) return { ...record, likes: comment.likes };
  const { target, basis } = pairing;
  return {
    ...record,
    replying_to_user: target.user,
    replying_to_text: target.nonText ? "" : target.text,
    ...(target.nonText ? { replying_to_non_text: true } : {}),
    replying_to_basis: basis,
    likes: comment.likes,
  };
}
