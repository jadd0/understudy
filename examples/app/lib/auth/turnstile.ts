import { getEnv } from "@/lib/env";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileDeps = { fetch?: typeof fetch; secret?: string };

/** Verify a Turnstile token with Cloudflare. Any missing token, bad response or network error is a failure. */
export async function verifyTurnstile(
  token: string | null | undefined,
  ip: string | null | undefined,
  deps: TurnstileDeps = {},
): Promise<boolean> {
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret: deps.secret ?? getEnv().TURNSTILE_SECRET_KEY, response: token });
    if (ip) body.set("remoteip", ip);
    const res = await (deps.fetch ?? fetch)(SITEVERIFY, { method: "POST", body });
    if (!res.ok) return false;
    const json = (await res.json()) as { success?: unknown };
    return json.success === true;
  } catch (e) {
    console.error("turnstile verify failed", (e as Error | undefined)?.name);
    return false;
  }
}
