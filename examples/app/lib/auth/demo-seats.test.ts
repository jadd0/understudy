import { describe, expect, test, vi } from "vitest";
import { captureSeatLink, captureSignInLink, checkSeatPassword, isDemoSeat, seatAwareSender } from "@/lib/auth/demo-seats";

const env = {
  SEED_CREATOR_EMAIL: "juno@understudy.example",
  SEED_ADMIN_EMAILS: "admin@understudy.example, ops@understudy.example",
  DEMO_SEAT_PASSWORD: "sea-glass-123",
} as unknown as NodeJS.ProcessEnv;

describe("demo seats", () => {
  test("seat emails come from the seed env, case- and space-insensitive", () => {
    expect(isDemoSeat(" juno@understudy.example ", env)).toBe(true);
    expect(isDemoSeat("ops@understudy.example", env)).toBe(true);
    expect(isDemoSeat("fan@example.com", env)).toBe(false);
  });

  test("password check: right, wrong, empty, non-string, unconfigured", () => {
    expect(checkSeatPassword("sea-glass-123", env)).toBe(true);
    expect(checkSeatPassword("sea-glass-124", env)).toBe(false);
    expect(checkSeatPassword("", env)).toBe(false);
    expect(checkSeatPassword(null, env)).toBe(false);
    expect(checkSeatPassword("sea-glass-123", { ...env, DEMO_SEAT_PASSWORD: undefined })).toBe(false);
  });

  test("a non-seat address is emailed by the provider's own sender", async () => {
    const send = vi.fn(async () => {});
    await seatAwareSender(send, env)({ identifier: "fan@example.com", url: "https://x/cb?token=1" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("a seat address outside the password-checked action is refused and never emailed", async () => {
    const send = vi.fn(async () => {});
    await expect(seatAwareSender(send, env)({ identifier: "juno@understudy.example", url: "https://x/cb?token=1" })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  test("inside a capture, the seat link is kept and not emailed", async () => {
    const send = vi.fn(async () => {});
    const sender = seatAwareSender(send, env);
    const link = await captureSeatLink(() => sender({ identifier: "juno@understudy.example", url: "https://x/cb?token=abc" }));
    expect(link).toBe("https://x/cb?token=abc");
    expect(send).not.toHaveBeenCalled();
  });

  test("simultaneous sign-ins each get their own link (no shared capture)", async () => {
    const sender = seatAwareSender(vi.fn(async () => {}), env);
    const slow = (token: string, ms: number) =>
      captureSeatLink(async () => {
        await new Promise((r) => setTimeout(r, ms));
        await sender({ identifier: "juno@understudy.example", url: `https://x/cb?token=${token}` });
      });
    const [a, b] = await Promise.all([slow("jad", 20), slow("sam", 5)]);
    expect(a).toBe("https://x/cb?token=jad");
    expect(b).toBe("https://x/cb?token=sam");
  });

  test("sim_link_captured_inside_capture", async () => {
    const send = vi.fn();
    const sender = seatAwareSender(send, env);
    const url = await captureSignInLink("Sim+Minor-ab12@sim.understudy.test", () => sender({ identifier: "sim+minor-ab12@sim.understudy.test", url: "https://app.test/cb?token=sim" }));
    expect(url).toBe("https://app.test/cb?token=sim");
    expect(send).not.toHaveBeenCalled();
  });

  test("sim_address_outside_capture_throws", async () => {
    const send = vi.fn();
    const sender = seatAwareSender(send, env);
    await expect(sender({ identifier: "sim+minor-ab12@sim.understudy.test", url: "https://app.test/cb" })).rejects.toThrow(/outside a capture/);
    // a capture for a different sim address does not cover this one either
    await expect(captureSignInLink("sim+other-0000@sim.understudy.test", () => sender({ identifier: "sim+minor-ab12@sim.understudy.test", url: "https://app.test/cb" }))).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  test("capture_ignores_other_identifier", async () => {
    const send = vi.fn();
    const sender = seatAwareSender(send, env);
    const url = await captureSignInLink("sim+a-1111@sim.understudy.test", () => sender({ identifier: "fan@example.com", url: "https://app.test/cb?x" }));
    expect(url).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
