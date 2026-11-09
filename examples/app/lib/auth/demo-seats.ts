import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Demo seats: the shared creator and admin accounts (`SEED_CREATOR_EMAIL`,
 * `SEED_ADMIN_EMAILS`) that several reviewers use at once. A seat never receives email: we don't
 * own its domain. Instead the sign-in action checks a shared password (`DEMO_SEAT_PASSWORD`),
 * asks Auth.js for a sign-in link as usual, catches the link here instead of mailing it, and sends
 * the browser to it. Auth.js still verifies the one-time token and creates the session, so we add
 * a check in front of the library's flow and never issue a session ourselves.
 *
 * Every sign-in is its own verification token and its own `sessions` row, and Auth.js never
 * revokes a user's other sessions, so any number of people can be signed into one seat at once.
 */

type Capture = { url: string | null; identifier?: string };

/** Sim fans (the fan simulator) never have a mailbox: their address is only ever used through a capture. */
export const SIM_EMAIL_DOMAIN = "sim.understudy.test";
export const isSimEmail = (email: string) => email.trim().toLowerCase().endsWith(`@${SIM_EMAIL_DOMAIN}`);

const capture = new AsyncLocalStorage<Capture>();

function normalise(email: string): string {
  return email.trim().toLowerCase();
}

export function demoSeatEmails(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const listed = [env.SEED_CREATOR_EMAIL ?? "", ...(env.SEED_ADMIN_EMAILS ?? "").split(",")];
  return new Set(listed.map(normalise).filter(Boolean));
}

export function isDemoSeat(email: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return demoSeatEmails(env).has(normalise(email));
}

/** Constant-time compare of digests, so neither length nor content leaks through timing. No password configured → always false. */
export function checkSeatPassword(given: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = env.DEMO_SEAT_PASSWORD;
  if (!expected || typeof given !== "string" || given.length === 0) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Runs `fn` (which calls Auth.js `signIn`) and returns the sign-in link Auth.js produced for a seat, instead of it being emailed. */
export async function captureSeatLink(fn: () => Promise<unknown>): Promise<string | null> {
  const box: Capture = { url: null };
  await capture.run(box, fn);
  return box.url;
}

/**
 * Runs `fn` (which calls Auth.js `signIn` for one sim fan) and returns the sign-in link Auth.js produced for that
 * address instead of it being emailed. Only that identifier is captured; any other address inside `fn` is sent as usual.
 */
export async function captureSignInLink(identifier: string, fn: () => Promise<unknown>): Promise<string | null> {
  const box: Capture = { url: null, identifier: normalise(identifier) };
  await capture.run(box, fn);
  return box.url;
}

type VerificationParams = { identifier: string; url: string };

/**
 * Wraps the provider's own `sendVerificationRequest`. Seat address inside a capture → keep the
 * link, send nothing. Seat address outside one (any other path into Auth.js) → throw, so a seat
 * link is never emailed and never issued without the password check. Anyone else → normal email.
 */
export function seatAwareSender<P extends VerificationParams>(send: (params: P) => unknown, env: NodeJS.ProcessEnv = process.env) {
  return async (params: P): Promise<void> => {
    if (isSimEmail(params.identifier)) {
      const box = capture.getStore();
      if (!box || box.identifier !== normalise(params.identifier)) throw new Error("sim fan sign-in link requested outside a capture for that address");
      box.url = params.url;
      return;
    }
    if (!isDemoSeat(params.identifier, env)) {
      await send(params);
      return;
    }
    const box = capture.getStore();
    if (!box) throw new Error("demo seat sign-in link requested outside the password-checked action");
    box.url = params.url;
  };
}
