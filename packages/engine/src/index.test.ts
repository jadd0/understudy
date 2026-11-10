import { describe, expect, test } from "vitest";
import { createUnderstudy, type UnderstudyOptions } from "./index.js";

describe("the engine's public entry", () => {
  test("the public entry exports exactly the factory, the errors, the host constants, systemClock and the retrieval functions", async () => {
    const entry = await import("./index.js");
    expect(Object.keys(entry).sort()).toEqual(
      [
        "ConfigMissing",
        "DeciderUnavailable",
        "GeneratorError",
        "MAX_CLIENT_MSG_ID_CHARS",
        "MAX_HUMAN_BODY_CHARS",
        "MAX_MESSAGE_CHARS",
        "MessageRefused",
        "TIP_ROW_PREFIX",
        "TakeoverRefused",
        "TypeSafeNotConfigured",
        "createUnderstudy",
        "retrieveFts",
        "retrieveHybrid",
        "retrieveVector",
        "systemClock",
      ].sort(),
    );
  });

  test("createUnderstudy returns one object with exactly these methods", () => {
    const understudy = createUnderstudy({} as unknown as UnderstudyOptions);
    const keys = Object.keys(understudy).sort();
    expect(keys).toEqual(
      ["creatorAi", "expireOffers", "handBack", "handleMessage", "humanReply", "migrate", "processConversation", "runTurn", "setCreatorAi", "sweep", "takeOver"].sort(),
    );
    expect(keys).toHaveLength(11);
    for (const key of keys) expect(typeof (understudy as unknown as Record<string, unknown>)[key]).toBe("function");
  });
});
