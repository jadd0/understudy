import { afterEach, describe, expect, test, vi } from "vitest";
import { emailProvider } from "@/lib/auth";

const params = (identifier: string) => ({ identifier, url: "http://localhost:3000/api/auth/callback/resend?token=t", provider: {}, theme: {}, expires: new Date() }) as never;

afterEach(() => vi.restoreAllMocks());

describe("emailProvider", () => {
  test("without Resend, outside production, the link goes to the console and nothing is fetched", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const p = emailProvider({ NODE_ENV: "development" });
    expect(p.id).toBe("resend");
    expect(p.type).toBe("email");
    await p.sendVerificationRequest(params("fan@example.com"));
    expect(log).toHaveBeenCalledWith("sign-in link for fan@example.com: http://localhost:3000/api/auth/callback/resend?token=t");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("in production without Resend there is no provider, so no link can be logged", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => emailProvider({ NODE_ENV: "production" })).toThrow(/RESEND_API_KEY and EMAIL_FROM/);
    expect(() => emailProvider({ NODE_ENV: "production", RESEND_API_KEY: "re_x" })).toThrow(/EMAIL_FROM/);
    expect(log).not.toHaveBeenCalled();
  });

  test("with both keys the provider is Resend's own, so a link is mailed and never logged", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const p = emailProvider({ NODE_ENV: "production", RESEND_API_KEY: "re_x", EMAIL_FROM: "Juno <hi@example.com>" });
    expect(p.id).toBe("resend");
    await p.sendVerificationRequest({ ...(params("fan@example.com") as object), provider: { apiKey: "re_x", from: "Juno <hi@example.com>" } } as never);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain("api.resend.com");
    expect(log).not.toHaveBeenCalled();
  });
});
