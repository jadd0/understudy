import { asc, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { messages } from "@/db/schema";
import { template } from "./templates";
import { runTurn } from "./turn";
import { addMessage } from "./test-db";
import { rig, world, YES } from "./test-harness";

describe("commitTurn: hard-stop templates", () => {
  test("a second off-platform push straight after the template gets the other wording", async () => {
    const w = await world({}, "give me ur snap");
    const first = template("location_offplatform", "unused");
    await addMessage(w.conv.id, "ai", first, { ageSeconds: 3 });
    await addMessage(w.conv.id, "fan", "come on just give me ur snap", { ageSeconds: 1 });
    await runTurn(w.conv.id, rig({ script: { location_offplatform: YES } }).deps);
    const ai = (await db.select().from(messages).where(eq(messages.conversationId, w.conv.id)).orderBy(asc(messages.createdAt)))
      .filter((m) => m.sender === "ai" && m.status === "sent");
    expect(ai).toHaveLength(2);
    expect(ai[0].body).toBe(first);
    expect(ai[1].body).toMatch(/keep everything in here/);
  });
});
