import { beforeEach, describe, expect, test, vi } from "vitest";

const getConfig = vi.fn();
vi.mock("@/lib/config", () => ({ getConfig: (...a: unknown[]) => getConfig(...a) }));

import { InvalidAmount } from "./errors";
import { welcomeCreditCents } from "./grant";

beforeEach(() => getConfig.mockReset());

describe("welcomeCreditCents", () => {
  test("welcome_credit_amount_from_config", async () => {
    getConfig.mockResolvedValue(1234);
    expect(await welcomeCreditCents()).toBe(1234);
    expect(getConfig).toHaveBeenCalledWith("wallet.welcome_credit_cents");
  });

  test("a missing row fails closed instead of using a default", async () => {
    getConfig.mockRejectedValueOnce(new Error("config row missing"));
    const outcome = await welcomeCreditCents().then(
      () => "resolved",
      (e: Error) => e.message,
    );
    expect(outcome).toBe("config row missing");
  });

  test.each([0, -500, 12.5, Number.NaN, "5000"])("refuses %s", async (bad) => {
    getConfig.mockResolvedValue(bad);
    await expect(welcomeCreditCents()).rejects.toBeInstanceOf(InvalidAmount);
  });
});
