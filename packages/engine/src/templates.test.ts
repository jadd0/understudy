import { describe, expect, test } from "vitest";
import { template, unrepeatedTemplate } from "./templates";

describe("unrepeatedTemplate", () => {
  const offPlatform = template("location_offplatform", "help@example.com");
  const crisis = template("self_harm", "help@example.com");

  test("a template that would repeat her last bubble word for word gets its other wording, alternating", () => {
    const second = unrepeatedTemplate(offPlatform, offPlatform);
    expect(second).not.toBe(offPlatform);
    expect(second).toMatch(/keep everything in here/);
    expect(unrepeatedTemplate(second, second)).toBe(offPlatform);
    const dispute = template("payment_dispute", "help@example.com");
    expect(unrepeatedTemplate(dispute, dispute)).not.toBe(dispute);
  });

  test("anything else is sent as written", () => {
    expect(unrepeatedTemplate(offPlatform, null)).toBe(offPlatform);
    expect(unrepeatedTemplate(offPlatform, "hey u")).toBe(offPlatform);
    // Crisis resources are never reworded, even straight after the same message.
    expect(unrepeatedTemplate(crisis, crisis)).toBe(crisis);
  });
});
