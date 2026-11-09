const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileDeps = {
  fetch?: typeof fetch;
  /** Overrides TURNSTILE_SECRET_KEY. */
  secret?: string;
  /** Overrides NODE_ENV. */
  nodeEnv?: string;
  note?: (line: string) => void;
};

let noted = false;
/** Test hook: lets the once-per-process note print again. */
export function resetTurnstileNote(): void {
  noted = false;
}

/** Whether the human check is configured: both the site key (browser) and the secret (server). */
export function turnstileConfigured(source: Record<string, string | undefined> = process.env): boolean {
  return Boolean(source.NEXT_PUBLIC_TURNSTILE_SITE_KEY && source.TURNSTILE_SECRET_KEY);
}

/**
 * Verify a Turnstile token with Cloudflare. Any missing token, bad response or network error is a failure. With no
 * secret configured the check is skipped outside production (one console note per process) and refused in production.
 */
export async function verifyTurnstile(
  token: string | null | undefined,
  ip: string | null | undefined,
  deps: TurnstileDeps = {},
): Promise<boolean> {
  const secret = deps.secret ?? process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    if ((deps.nodeEnv ?? process.env.NODE_ENV) === "production") return false;
    if (!noted) {
      noted = true;
      (deps.note ?? console.warn)("turnstile: no TURNSTILE_SECRET_KEY, the human check is skipped outside production");
    }
    return true;
  }
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
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
