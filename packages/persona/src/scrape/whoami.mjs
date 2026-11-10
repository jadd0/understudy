// Who a session belongs to. Every own-account path asks this before it writes or reads anything else.
import { HANDLE } from "../lib/handles.mjs";
import { ENDPOINTS, InstagramError } from "./instagram.mjs";

/** Raised when a handle other than the signed-in account's (or the export's) is asked for. `source` names which: "session" or "export". */
export class NotOwnAccount extends Error {
  constructor(owner, requested, source = "session") {
    super(`the ${source} belongs to @${owner}; refusing @${requested}`);
    this.name = "NotOwnAccount";
    this.owner = owner;
    this.requested = requested;
  }
}

/** The account the session cookie belongs to, as `{ username, pk }`. */
export async function resolveOwnHandle(client) {
  const response = await client.get(ENDPOINTS.currentUser());
  const user = response?.user;
  const username = user?.username;
  const pk = user?.pk ?? user?.id;
  if (typeof username !== "string" || !HANDLE.test(username) || pk === undefined || pk === null || String(pk) === "") {
    throw new InstagramError("could not tell which account this session belongs to: log in again and refresh IG_SESSIONID");
  }
  return { username, pk: String(pk) };
}
