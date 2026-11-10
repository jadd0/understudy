import { asc, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { messages } from "@/db/schema";
import { template } from "../drafting/templates.js";
import { runTurn } from "../turn/run.js";
import { addMessage } from "../testing/db.js";
import { rig, world, YES } from "../testing/harness.js";

describe("commitTurn: hard-stop templates", () => {
  test("a second payment dispute straight after the template gets the other wording", async () => {
    const w = await world({}, "i want a refund");
    const first = template("payment_dispute", "unused");
    await addMessage(w.conv.id, "ai", first, { ageSeconds: 3 });
    await addMessage(w.conv.id, "fan", "still want my refund", { ageSeconds: 1 });
    await runTurn(rig({ script: { payment_dispute: YES } }).ctx, w.conv.id);
    const ai = (await db.select().from(messages).where(eq(messages.conversationId, w.conv.id)).orderBy(asc(messages.createdAt)))
      .filter((m) => m.sender === "ai" && m.status === "sent");
    expect(ai).toHaveLength(2);
    expect(ai[0].body).toBe(first);
    expect(ai[1].body).toMatch(/already passed this/);
  });
});
