/**
 * The sign-in link without a mail provider: Auth.js still issues and later verifies the one-time token, and the link
 * it would have emailed is printed to the server console instead. A printed link signs anyone who can read the log
 * in as that address, so this refuses to run in production.
 */

type Params = { identifier: string; url: string };

export class DevLinkRefused extends Error {
  constructor() {
    super("the console sign-in link is off in production");
    this.name = "DevLinkRefused";
  }
}

export async function sendDevLink(
  { identifier, url }: Params,
  env: Record<string, string | undefined> = process.env,
  log: (line: string) => void = console.log,
): Promise<void> {
  if (env.NODE_ENV === "production") throw new DevLinkRefused();
  log(`sign-in link for ${identifier}: ${url}`);
}
