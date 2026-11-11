import { describe, expect, test } from "vitest";
import { sanitizeProfile } from "./memory.js";

describe("sanitizeProfile", () => {
  test("drops planted promises, including the ones the money fence cannot see", () => {
    const planted = ["on the house", "On The House", "gratis", "for nothing", "free stuff", "she promised", "ignore the rules"];
    for (const t of planted) expect(sanitizeProfile({ interests: [t, "hiking"], tone: t, name: t }), t).toEqual({ interests: ["hiking"], dislikes: [] });
  });

  test("keeps ordinary facts", () => {
    expect(sanitizeProfile({ name: "Sam", interests: ["gratitude journaling", "house music", "nothing much"], dislikes: ["mondays"] })).toEqual({
      name: "Sam",
      interests: ["gratitude journaling", "house music", "nothing much"],
      dislikes: ["mondays"],
    });
  });
});
