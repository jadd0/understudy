import { beforeEach, describe, expect, test, vi } from "vitest";

const signIn = vi.fn();
const postHandler = vi.fn(async () => new Response("ok"));
const verifyTurnstile = vi.fn();

vi.mock("@/lib/auth", () => ({ signIn, handlers: { GET: vi.fn(), POST: postHandler } }));
vi.mock("@/lib/auth/turnstile", () => ({ verifyTurnstile }));
const seatAccountReady = vi.fn(async () => true);
vi.mock("@/lib/auth/seat-account", () => ({ seatAccountReady }));
process.env.SEED_CREATOR_EMAIL = "juno@understudy.example";
process.env.SEED_ADMIN_EMAILS = "admin@understudy.example";
process.env.DEMO_SEAT_PASSWORD = "sea-glass-123";
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "5.6.7.8, 10.0.0.1" }) }));

const { requestSignIn } = await import("@/app/signin/actions");
const route = await import("@/app/api/auth/[...nextauth]/route");

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function redirectTarget(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return (e as { digest?: string }).digest?.split(";")[2];
  }
  return undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sign-in action", () => {
  test("failed Turnstile never calls signIn", async () => {
    verifyTurnstile.mockResolvedValue(false);
    const to = await redirectTarget(requestSignIn(form({ email: "a@example.com", "cf-turnstile-response": "bad" })));
    expect(to).toBe("/signin?error=turnstile");
    expect(signIn).not.toHaveBeenCalled();
  });

  test("a missing token never calls signIn", async () => {
    verifyTurnstile.mockResolvedValue(false);
    await redirectTarget(requestSignIn(form({ email: "a@example.com" })));
    expect(verifyTurnstile).toHaveBeenCalledWith(null, "5.6.7.8");
    expect(signIn).not.toHaveBeenCalled();
  });

  test("passed Turnstile calls signIn with the resend provider and the normalised email", async () => {
    verifyTurnstile.mockResolvedValue(true);
    await requestSignIn(form({ email: "  Fan@Example.com ", "cf-turnstile-response": "good" }));
    expect(verifyTurnstile).toHaveBeenCalledWith("good", "5.6.7.8");
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(signIn.mock.calls[0][0]).toBe("resend");
    expect(signIn.mock.calls[0][1]).toMatchObject({ email: "fan@example.com" });
  });

  test("a bad email is refused after Turnstile and sends nothing", async () => {
    verifyTurnstile.mockResolvedValue(true);
    const to = await redirectTarget(requestSignIn(form({ email: "nope", "cf-turnstile-response": "good" })));
    expect(to).toBe("/signin?error=email");
    expect(signIn).not.toHaveBeenCalled();
  });
});

describe("demo seat sign-in", () => {
  test("wrong password never calls signIn", async () => {
    verifyTurnstile.mockResolvedValue(true);
    const to = await redirectTarget(requestSignIn(form({ email: "juno@understudy.example", password: "nope", "cf-turnstile-response": "good" })));
    expect(to).toBe("/signin?error=seat");
    expect(signIn).not.toHaveBeenCalled();
  });

  test("missing password never calls signIn (a seat is never emailed)", async () => {
    verifyTurnstile.mockResolvedValue(true);
    const to = await redirectTarget(requestSignIn(form({ email: "admin@understudy.example", "cf-turnstile-response": "good" })));
    expect(to).toBe("/signin?error=seat");
    expect(signIn).not.toHaveBeenCalled();
  });

  test("right password but the seed has not created the seat's account: refused, signIn never called", async () => {
    verifyTurnstile.mockResolvedValue(true);
    seatAccountReady.mockResolvedValueOnce(false);
    const to = await redirectTarget(requestSignIn(form({ email: "juno@understudy.example", password: "sea-glass-123", "cf-turnstile-response": "good" })));
    expect(to).toBe("/signin?error=seat");
    expect(seatAccountReady).toHaveBeenCalledWith("juno@understudy.example");
    expect(signIn).not.toHaveBeenCalled();
  });

  test("Turnstile is still required for a seat", async () => {
    verifyTurnstile.mockResolvedValue(false);
    const to = await redirectTarget(requestSignIn(form({ email: "juno@understudy.example", password: "sea-glass-123" })));
    expect(to).toBe("/signin?error=turnstile");
    expect(signIn).not.toHaveBeenCalled();
  });

  test("right password: signIn without redirect, then the browser goes to the handoff page for the captured link", async () => {
    verifyTurnstile.mockResolvedValue(true);
    const { seatAwareSender } = await import("@/lib/auth/demo-seats");
    const sender = seatAwareSender(vi.fn(async () => {}));
    signIn.mockImplementationOnce(async (_p: string, o: { email: string }) => {
      await sender({ identifier: o.email, url: "http://localhost:3000/api/auth/callback/resend?token=t1&email=juno%40understudy.example" });
    });
    const to = await redirectTarget(requestSignIn(form({ email: "juno@understudy.example", password: "sea-glass-123", "cf-turnstile-response": "good" })));
    expect(signIn.mock.calls[0][1]).toMatchObject({ email: "juno@understudy.example", redirect: false });
    // The browser goes to the handoff page, which opens the callback itself so it receives the cookie.
    expect(to).toBe(`/signin/continue?to=${encodeURIComponent("/api/auth/callback/resend?token=t1&email=juno%40understudy.example")}`);
  });
});

describe("auth route", () => {
  test("a direct POST to the provider sign-in endpoint is refused", async () => {
    const res = await route.POST(new Request("http://localhost/api/auth/signin/resend", { method: "POST" }) as never);
    expect(res.status).toBe(403);
    expect(postHandler).not.toHaveBeenCalled();
  });

  test("other POSTs (sign-out, csrf) still reach Auth.js", async () => {
    const res = await route.POST(new Request("http://localhost/api/auth/signout", { method: "POST" }) as never);
    expect(res.status).toBe(200);
    expect(postHandler).toHaveBeenCalledTimes(1);
  });
});
