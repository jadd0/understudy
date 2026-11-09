import { describe, expect, test } from "vitest";
import { activeHref } from "./active-href";

const creatorLinks = [
  { href: "/console", label: "Inbox" },
  { href: "/console/settings", label: "Settings" },
  { href: "/analytics", label: "Analytics" },
];
const adminLinks = [
  { href: "/admin", label: "Safety queue" },
  { href: "/admin/sim", label: "Simulator" },
  { href: "/analytics", label: "Analytics" },
];

describe("activeHref", () => {

  test("picks the deepest matching section", () => {
    expect(activeHref(creatorLinks, "/console")).toBe("/console");
    expect(activeHref(creatorLinks, "/console/7f1c2b9e-0000-4000-8000-000000000000")).toBe("/console");
    expect(activeHref(creatorLinks, "/console/settings")).toBe("/console/settings");
    expect(activeHref(adminLinks, "/admin/sim")).toBe("/admin/sim");
    expect(activeHref(adminLinks, "/admin/7f1c2b9e-0000-4000-8000-000000000000")).toBe("/admin");
    expect(activeHref(adminLinks, "/analytics/turns/abc")).toBe("/analytics");
  });

  test("a prefix that is not a path segment does not match", () => {
    expect(activeHref(adminLinks, "/administrator")).toBeNull();
    expect(activeHref(creatorLinks, "/chat")).toBeNull();
  });
});
