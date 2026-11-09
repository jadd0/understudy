import { describe, expect, test } from "vitest";
import { strikeNotice, template, unrepeatedTemplate } from "./templates";

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

describe("strikeNotice", () => {
  test("the warnings and the paused notice are the founder's wording", () => {
    expect(strikeNotice(1, 3)).toBe(
      "Warning 1 of 3: keep it on the app. Meetups, other apps and outside payments aren't allowed. 3 warnings pauses this chat.",
    );
    expect(strikeNotice(2, 3)).toBe(
      "Warning 2 of 3: keep it on the app. Meetups, other apps and outside payments aren't allowed. 3 warnings pauses this chat.",
    );
    expect(strikeNotice(3, 3)).toBe("Warning 3 of 3: this chat is paused for a safety review. You can still read it.");
    expect(strikeNotice(5, 5)).toBe("Warning 5 of 5: this chat is paused for a safety review. You can still read it.");
    expect(strikeNotice(4, 5)).toContain("5 warnings pauses this chat.");
  });
});
