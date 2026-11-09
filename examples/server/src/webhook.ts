import { createHmac } from "node:crypto";

export const SIGNATURE_HEADER = "x-understudy-signature";

/** `sha256=<hex>`: the HMAC-SHA256 of the raw request body under the shared secret. */
export function sign(rawBody: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export interface WebhookOptions {
  url: string;
  secret: string;
  attempts?: number;
  timeoutMs?: number;
  /** Waits before attempt n+1; tests shorten it. */
  backoffMs?: (attempt: number) => number;
  fetch?: typeof fetch;
  /** Gets the error class only, never its message. */
  log?: (line: string) => void;
}

export interface Webhook {
  /** Sends one event and resolves true once the endpoint answered 2xx; false after the last attempt. Never throws. */
  deliver(event: Record<string, unknown>): Promise<boolean>;
  /** Fire and forget: the engine and the SSE stream never wait for the endpoint. */
  send(event: Record<string, unknown>): void;
  /** Resolves when every send in flight has finished. */
  idle(): Promise<void>;
}

export function createWebhook(opts: WebhookOptions): Webhook {
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const backoff = opts.backoffMs ?? ((n) => 250 * 4 ** n);
  const doFetch = opts.fetch ?? globalThis.fetch;
  const log = opts.log ?? ((line) => console.warn(line));
  const inflight = new Set<Promise<boolean>>();

  async function deliver(event: Record<string, unknown>): Promise<boolean> {
    const raw = JSON.stringify(event);
    const headers = { "content-type": "application/json", [SIGNATURE_HEADER]: sign(raw, opts.secret) };
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await doFetch(opts.url, { method: "POST", headers, body: raw, signal: AbortSignal.timeout(timeoutMs) });
        if (res.ok) return true;
        log(`webhook: status ${res.status} (attempt ${attempt + 1} of ${attempts})`);
      } catch (e) {
        log(`webhook: ${(e as Error)?.name ?? "error"} (attempt ${attempt + 1} of ${attempts})`);
      }
      if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, backoff(attempt)));
    }
    return false;
  }

  return {
    deliver,
    send(event) {
      const p = deliver(event).catch(() => false);
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
    },
    async idle() {
      await Promise.all([...inflight]);
    },
  };
}
