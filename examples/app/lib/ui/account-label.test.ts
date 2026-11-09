import { describe, expect, test } from "vitest";
import { accountName, roleLabel } from "@/lib/ui/account-label";

describe("account label", () => {
  test("role labels", () => {
    expect([roleLabel("fan"), roleLabel("creator"), roleLabel("admin")]).toEqual(["Fan", "Creator", "Trust & Safety"]);
  });
  test("name, else email local part, else role label", () => {
    expect(accountName({ name: " Sam Carter ", email: "s@x.io" }, "fan")).toBe("Sam Carter");
    expect(accountName({ name: null, email: "sam@x.io" }, "fan")).toBe("sam");
    expect(accountName({ name: "", email: null }, "admin")).toBe("Trust & Safety");
  });
});
