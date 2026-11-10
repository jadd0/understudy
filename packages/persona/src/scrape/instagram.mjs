// The only code that talks to Instagram: a GET-only client over an injected fetch.
//
// It refuses any other method before fetch is called, sends the session cookie only to
// ORIGIN, and never logs or throws a response body or the cookie. The endpoint paths below are
// the web app's own JSON endpoints, written from how the site behaves; they are unverified
// until a live run on your own account, and this table is the one place to change them.

export const ORIGIN = "https://www.instagram.com";
export const APP_ID = "936619743392459";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Endpoint paths. The reels tab is served by a POST endpoint on the web app, so a reel that
// appears only there (not in the profile grid) is out of scope: this client never POSTs.
export const ENDPOINTS = {
  // Names the account a session belongs to. The path is the one the mobile API serves; the web origin is
  // not confirmed to answer it, so a live run on your own account is what proves it.
  currentUser: () => "/api/v1/accounts/current_user/?edit=true",
  profile: (handle) => `/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`,
  feed: (userId, maxId) => `/api/v1/feed/user/${userId}/?count=12${maxId ? `&max_id=${encodeURIComponent(maxId)}` : ""}`,
  info: (mediaId) => `/api/v1/media/${mediaId}/info/`,
  comments: (mediaId, minId) => `/api/v1/media/${mediaId}/comments/${minId ? `?min_id=${encodeURIComponent(minId)}` : ""}`,
  children: (mediaId, commentId, maxId) =>
    `/api/v1/media/${mediaId}/comments/${commentId}/child_comments/${maxId ? `?max_id=${encodeURIComponent(maxId)}` : ""}`,
};

/** A failed request. Carries the status and class only: never a response body or the cookie. */
export class InstagramError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = "InstagramError";
    this.status = status;
  }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ fetch: typeof fetch, sessionId: string, delayMs?: number, sleep?: (ms: number) => Promise<void> }} options
 */
export function createClient({ fetch: fetchImpl, sessionId, delayMs = 1500, sleep = realSleep }) {
  if (typeof sessionId !== "string" || sessionId === "") throw new InstagramError("a session id is required");
  let requests = 0;

  async function request(method, path) {
    if (method !== "GET") throw new InstagramError(`refusing ${String(method)}: this client only issues GET`);
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
      throw new InstagramError("request path must be a path on instagram.com");
    }
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN) throw new InstagramError("request must target instagram.com");

    if (requests > 0 && delayMs > 0) await sleep(delayMs);
    requests++;

    let response;
    try {
      response = await fetchImpl(url.href, {
        method: "GET",
        redirect: "error",
        headers: {
          accept: "application/json",
          "user-agent": USER_AGENT,
          "x-ig-app-id": APP_ID,
          cookie: `sessionid=${sessionId}`,
        },
      });
    } catch (error) {
      // The cause can quote the request, so only its class is kept.
      throw new InstagramError(`request failed (${error?.name ?? "Error"})`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new InstagramError(`HTTP ${response.status}: the session was refused; log in again and refresh IG_SESSIONID`, { status: response.status });
    }
    if (response.status === 429) {
      throw new InstagramError("HTTP 429: rate limited; wait before running again, or raise --delay-ms", { status: 429 });
    }
    if (!response.ok) throw new InstagramError(`HTTP ${response.status}`, { status: response.status });
    try {
      return await response.json();
    } catch {
      throw new InstagramError("response was not JSON", { status: response.status });
    }
  }

  return {
    request,
    get: (path) => request("GET", path),
    get requestCount() {
      return requests;
    },
  };
}
