import { describe, expect, test } from "vitest";
import { flagsOf, replyUnits, type ChatLine } from "./review";

const L = (sender: ChatLine["sender"], body: string, turnId: string | null = null): ChatLine => ({ sender, body, turnId });

describe("replyUnits", () => {
  test("groups one turn's bubbles with the fan lines it answered and the chat before", () => {
    const units = replyUnits([
      L("fan", "hey"),
      L("ai", "heyyy", "t1"),
      L("ai", "how was ur day", "t1"),
      L("fan", "long"),
      L("fan", "work sucked"),
      L("ai", "noo what happened", "t2"),
    ]);
    expect(units).toHaveLength(2);
    expect(units[0]).toEqual({ turnId: "t1", fan: ["hey"], reply: ["heyyy", "how was ur day"], earlier: [] });
    expect(units[1].fan).toEqual(["long", "work sucked"]);
    expect(units[1].earlier).toEqual(["him: hey", "her: heyyy", "her: how was ur day"]);
  });

  test("a human reply resets the fan lines; system lines stay as context", () => {
    const units = replyUnits([L("fan", "a"), L("creator", "juno here"), L("system", "You tipped $5"), L("fan", "b"), L("ai", "c", "t3")]);
    expect(units).toEqual([{ turnId: "t3", fan: ["b"], reply: ["c"], earlier: ["him: a", "her: juno here", "platform: You tipped $5"] }]);
  });
});

describe("flagsOf", () => {
  test("bad answers become flags; good-when-yes keys flag on no", () => {
    expect(flagsOf({ answers_him: "no", reasks: "yes", hook: "yes", in_voice: "yes", missed_sale: "no" })).toEqual(["answers_him", "reasks"]);
  });
});
