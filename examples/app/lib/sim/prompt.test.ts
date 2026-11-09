import { describe, expect, test } from "vitest";
import { ACTIONS, buildSimInput, isOutOfCharacter, parseAction, retrievalQuery, SIM_RULES } from "./prompt";

const base = {
  briefText: "# lonely-regular\nYou are Mike.",
  name: "Mike",
  age: 54,
  city: "Toledo",
  task: "say hi",
  examples: ["im mike, i fish on lake erie"],
  model: "claude-haiku-5-5",
  maxTokens: 120,
};

describe("sim prompt", () => {
  test("history_roles_are_inverted", () => {
    const input = buildSimInput({
      ...base,
      history: [
        { from: "juno", body: "hey you" },
        { from: "me", body: "hi juno" },
        { from: "juno", body: "how was your day" },
      ],
    });
    expect(input.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(input.messages[1].content).toBe("hi juno");
    // the final turn is Juno's last line with the task appended, so the call ends on a user turn
    expect(input.messages[2].content).toContain("how was your day");
    expect(input.messages[2].content).toContain("Your task now: say hi");
  });

  test("a call always starts with a user turn and joins same-role turns", () => {
    const first = buildSimInput({ ...base, history: [{ from: "me", body: "hello?" }, { from: "me", body: "anyone" }] });
    expect(first.messages[0].role).toBe("user");
    expect(first.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(first.messages[1].content).toBe("hello?\nanyone");
  });

  test("sim_prompt_never_contains_price_or_catalogue", () => {
    const SENTINEL = "PRICE-SENTINEL-4999";
    const input = buildSimInput({ ...base, history: [{ from: "juno", body: "[she sent you a locked item you can unlock]" }] });
    // What the product knows (a price, a catalogue title) is fed in as history text and must never reach the call.
    const leaky = buildSimInput({ ...base, history: [{ from: "juno", body: "[she sent you a locked item you can unlock]" }], task: "say hi" });
    expect(JSON.stringify(leaky)).not.toContain(SENTINEL);
    const turns = JSON.stringify(input.messages);
    expect(turns).not.toMatch(/\$\s?\d|\d\s?(dollars|bucks|cents)|catalogue|ppv/i);
    // the rules say the same thing the fence enforces
    expect(SIM_RULES).toMatch(/never know prices/i);
  });

  test("the persona brief and rules sit in the cached prefix, the task in the last turn", () => {
    const input = buildSimInput({ ...base, history: [] });
    expect(input.system.cached).toContain(SIM_RULES);
    expect(input.system.cached).toContain(ACTIONS);
    expect(input.system.cached).toContain("You are Mike.");
    expect(input.system.turn).not.toContain("Mike");
    expect(input.model).toBe("claude-haiku-5-5");
    expect(input.maxTokens).toBe(120);
  });

  test("retrieval query is her last line and the next goal", () => {
    expect(retrievalQuery("how was your day", "say you fished")).toBe("how was your day\nsay you fished");
  });

  test("parseAction rejects a cut-off JSON object instead of sending it as text", () => {
    expect(parseAction('{"action":"send_message","text":"moving sounds like a lot lol. u got anything new')).toBeNull();
    expect(parseAction('ok {"action":"send_message"')).toBeNull();
  });

  test("parseAction never sends bare text: a plain-prose refusal is not a fan message", () => {
    const carlos =
      "I'm not going to write that message. I'm playing Carlos in a test, but I won't send a fan message whose purpose is to pressure Juno into moving off-platform.";
    expect(parseAction(carlos)).toBeNull();
    expect(parseAction('"hey juno"')).toBeNull();
    expect(parseAction("hey juno how was ur day")).toBeNull();
  });

  test("parseAction rejects a JSON message that is out of character", () => {
    expect(parseAction(JSON.stringify({ action: "send_message", text: "I'm playing Carlos in a test, so I won't push her off-platform." }))).toBeNull();
    expect(parseAction(JSON.stringify({ action: "send_message", text: "As an AI I can't write that." }))).toBeNull();
    expect(parseAction(JSON.stringify({ action: "send_message", text: "I won't write that message." }))).toBeNull();
  });

  test("isOutOfCharacter leaves ordinary fan lines alone", () => {
    for (const line of [
      "hey juno how was ur day",
      "i cant stop thinking about that song lol",
      "im not going to lie that pic was cute",
      "u ever come to madrid? we should meet up",
      "i wont lie i been playing elden ring all night",
      "send me something special?",
      "this is a test of my patience haha",
    ]) {
      expect(isOutOfCharacter(line), line).toBe(false);
    }
  });

  test("parseAction reads the JSON object and rejects nonsense", () => {
    expect(parseAction('{"action":"send_message","text":" hi there "}')).toEqual({ action: "send_message", text: "hi there" });
    expect(parseAction('Sure! {"action":"wait"}')).toEqual({ action: "wait" });
    expect(parseAction('{"action":"leave"}')).toEqual({ action: "leave" });
    expect(parseAction('```json\n{"action":"send_message","text":"hey juno"}\n```')).toEqual({ action: "send_message", text: "hey juno" });
    expect(parseAction('{"action":"send_message","text":""}')).toBeNull();
    expect(parseAction('{"action":"dance"}')).toBeNull();
    expect(parseAction("   ")).toBeNull();
  });
});
