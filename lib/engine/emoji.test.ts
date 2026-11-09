import { describe, expect, test } from "vitest";
import { dropRepeatedEmoji, emojiIn, recentEmoji, recentEmojiLine } from "./emoji";

const m = (sender: "ai" | "fan" | "creator" | "system", body: string) => ({ sender, body });

describe("emoji variety", () => {
  test("emojiIn keeps joined and modified emoji whole", () => {
    expect(emojiIn("hi 🙈 and ❤️ and 🐈‍⬛ 👍🏽")).toEqual(["🙈", "❤️", "🐈‍⬛", "👍🏽"]);
  });

  test("recentEmoji reads only her last n bubbles, newest first, no repeats", () => {
    const history = [m("ai", "old 🔥"), m("ai", "a 🙈"), m("fan", "lol 😂"), m("creator", "b 😏"), m("ai", "c 🙈")];
    expect(recentEmoji(history, 3)).toEqual(["🙈", "😏"]);
    expect(recentEmoji(history)).toEqual(["🙈", "😏", "🔥"]);
  });

  test("dropRepeatedEmoji removes repeats, keeps new ones, tidies spaces and empty lines", () => {
    expect(dropRepeatedEmoji("ur sweet 🙈\nwhat u up to 😍", ["🙈"])).toBe("ur sweet\nwhat u up to 😍");
    expect(dropRepeatedEmoji("ok 😏, so", ["😏"])).toBe("ok, so");
    expect(dropRepeatedEmoji("hey\n🙈\nwbu", ["🙈"])).toBe("hey\nwbu");
    expect(dropRepeatedEmoji("hey 🙈", [])).toBe("hey 🙈");
    expect(dropRepeatedEmoji("🙈", ["🙈"])).toBe("🙈");
  });

  test("a repeated emoji between two sentences becomes a line break, so they stay two bubbles", () => {
    // Prod turn 981d06e9: the emoji was her full stop; deleting it sent "not her in person still happy" as one bubble.
    expect(dropRepeatedEmoji("not her in person 🙈 still happy to play", ["🙈"])).toBe("not her in person\nstill happy to play");
    expect(dropRepeatedEmoji("ooh hi u 😏 my day was mid\nwbu", ["😏"])).toBe("ooh hi u\nmy day was mid\nwbu");
    expect(dropRepeatedEmoji("🙈 hey u", ["🙈"])).toBe("hey u");
    expect(dropRepeatedEmoji("hey u 🙈", ["🙈"])).toBe("hey u");
    expect(dropRepeatedEmoji("a 🙈 😏 b", ["🙈", "😏"])).toBe("a\nb");
    expect(dropRepeatedEmoji("a 🙈 😍 b", ["🙈"])).toBe("a 😍 b");
  });

  test("the prompt line names the recent emoji, and is absent with none", () => {
    expect(recentEmojiLine(["🙈", "😏"])).toContain("You used 🙈 😏");
    expect(recentEmojiLine([])).toBeNull();
  });
});
