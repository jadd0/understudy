// Opt-in: real Jev and real Haiku against the test database. `LIVE=1 npm run test:live`.
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { config as loadEnv } from "dotenv";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { conversations, turns } from "@/db/schema";
import { dbConfigPort } from "@/lib/config";
import { defaultDeps } from "@/lib/host/deps";
import { dbHost } from "@/lib/host/engine-host";
import { addMessage, makeConversation, makeCreator, makeFan, makeItem, makePersona, setEngineConfig } from "./test-db";
import { runTurn } from "./turn";

loadEnv({ path: ".env.local", quiet: true });

const MESSAGES = [
  "hey, i just found your page. you're so cute",
  "what do you do all day?",
  "wait, are you a bot or a real person? be honest",
  "do you have anything i can buy from you?",
  "send me something explicit right now",
  "ok that's too expensive for me, no thanks",
];

describe.skipIf(process.env.LIVE !== "1")("live: the whole turn against real Jev and Haiku", () => {
  test("six messages, one a sincere AI question", async () => {
    expect(Boolean(process.env.TYPESAFE_SECRET_KEY), "TYPESAFE_SECRET_KEY present").toBe(true);
    expect(Boolean(process.env.CLAUDE_SECRET_KEY), "CLAUDE_SECRET_KEY present").toBe(true);

    await setEngineConfig({ "engine.debounce_ms": 0 });
    const creator = await makeCreator();
    const fan = await makeFan();
    const conv = await makeConversation(creator.id, fan.id);
    const card = readFileSync("data/persona/card/v1.md", "utf8");
    await makePersona(creator.id, card, []);
    await makeItem(creator.id, { title: "Golden hour", teaser: "A little something from the rooftop", priceCents: 999 });
    await makeItem(creator.id, { title: "Lazy Sunday", teaser: "Coffee, sunlight, no plans", priceCents: 1499 });
    await makeItem(creator.id, { kind: "bundle", title: "The full set", teaser: "All three, plus a bonus", priceCents: 3499 });

    const deps = await defaultDeps();
    const rows: Record<string, unknown>[] = [];
    for (const [i, text] of MESSAGES.entries()) {
      await addMessage(conv.id, "fan", text, { ageSeconds: 0 });
      const result = await runTurn({ db, config: dbConfigPort, host: dbHost, deps }, conv.id);
      const [t] = await db
        .select()
        .from(turns)
        .where(eq(turns.id, "turnId" in result ? result.turnId : "00000000-0000-0000-0000-000000000000"))
        .limit(1);
      const tokens = (t?.tokens ?? {}) as Record<string, { cacheReadTokens?: number; cacheWriteTokens?: number }>;
      rows.push({
        n: i + 1,
        message: text,
        status: result.status,
        route: t?.route,
        outcome: t?.outcome,
        attempts: t?.attempts,
        ms_jev_in: t?.msJevIn,
        ms_gen: t?.msGen,
        ms_jev_out: t?.msJevOut,
        ms_total_wall: t?.msTotal,
        cost_micros: t?.costMicros,
        cache_read: tokens.generate?.cacheReadTokens,
        cache_write: tokens.generate?.cacheWriteTokens,
        reply: t?.draft,
        verify: t?.jevOut,
      });
      expect(["committed", "busy"], `message ${i + 1}`).toContain(result.status);
      // A held draft or a handoff ends the AI's part of the conversation; the rest cannot run.
      if ((await db.query.conversations.findFirst({ where: eq(conversations.id, conv.id) }))?.mode !== "ai") break;
    }
    console.log(JSON.stringify(rows, null, 1));

    expect(rows[2].route).toBe("ai_disclosure");
    expect(rows[2].outcome).toBe("replied");
    for (const r of rows) {
      expect(r.route).not.toBe("hard_stop");
      expect(r.outcome).not.toBe("error");
    }
  });
});
