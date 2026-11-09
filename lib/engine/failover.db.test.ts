import { describe, expect, test } from "vitest";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { messages, turns } from "@/db/schema";
import { DeciderUnavailable, type Decider } from "@/platform/ports/decider";
import { GeneratorError, type Generator } from "@/platform/ports/generator";
import { FailoverDecider } from "@/providers/failover/decider";
import { FailoverGenerator } from "@/providers/failover/generator";
import { VERIFY_QUESTIONS } from "./questions";
import { runTurn } from "./turn";
import { getConversation } from "./test-db";
import { rig, world } from "./test-harness";

const clock = { t: 0, now() { return this.t; } };
const breaker = { failures: 2, windowMs: 60_000, cooldownMs: 30_000, clock };

function down(reason = "http_503") {
  const d = { calls: 0, ask: async () => { d.calls++; throw new DeciderUnavailable(reason); } };
  return d as Decider & { calls: number };
}
const aiMessages = (conversationId: string) =>
  db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt)).then((rows) => rows.filter((m) => m.sender === "ai"));

describe("failover behind the ports", () => {
  test("the primary decider down: a turn completes through the fallback and the verify question is answered", async () => {
    const w = await world();
    const r = rig();
    const primary = down();
    const lines: string[] = [];
    r.deps.decider = new FailoverDecider([{ name: "jev", decider: primary }, { name: "claude", decider: r.decider }], breaker, (l) => lines.push(l));
    const result = await runTurn(w.conv.id, r.deps);
    expect(result).toMatchObject({ status: "committed", outcome: "replied" });
    expect(await aiMessages(w.conv.id)).toHaveLength(1);
    // the working decider saw the inbound read and then the verify questions: none was skipped
    const asked = r.decider.calls.map((c) => c.keys);
    expect(asked[0]).toContain("intent");
    const verifyKeys = VERIFY_QUESTIONS.map((q) => q.key);
    expect(verifyKeys.length).toBeGreaterThan(0);
    expect(asked.some((keys) => verifyKeys.every((k) => keys.includes(k)))).toBe(true);
    expect(primary.calls).toBeGreaterThan(0);
    expect(lines[0]).toBe("provider: jev unavailable (http_503), using claude");
  });

  test("both deciders down: the turn fails and is recorded, and no partial reply is sent", async () => {
    const w = await world();
    const r = rig();
    r.deps.decider = new FailoverDecider([{ name: "jev", decider: down("http_503") }, { name: "claude", decider: down("timeout") }], breaker, () => {});
    expect((await runTurn(w.conv.id, r.deps)).status).toBe("error");
    expect((await db.select().from(turns).where(eq(turns.conversationId, w.conv.id))).map((t) => t.outcome)).toEqual(["error"]);
    expect(await aiMessages(w.conv.id)).toHaveLength(0);
    expect(await getConversation(w.conv.id)).toMatchObject({ mode: "ai", failedTurns: 1 });
  });

  test("an open breaker on the primary: zero calls reach it during the cooldown", async () => {
    clock.t = 1_000_000;
    const primary = down();
    const fallback = rig();
    const decider = new FailoverDecider([{ name: "jev", decider: primary }, { name: "claude", decider: fallback.decider }], breaker, () => {});
    const q = [{ key: "q", prompt: "p", options: [{ key: "a", label: "A" }] }];
    await decider.ask(q, { state: {} });
    await decider.ask(q, { state: {} });
    const before = primary.calls;
    expect(before).toBe(2);
    for (let i = 0; i < 5; i++) await decider.ask(q, { state: {} });
    expect(primary.calls).toBe(before);
    clock.t += 30_000;
    await decider.ask(q, { state: {} });
    expect(primary.calls).toBe(before + 1);
  });

  test("the primary generator model down: the draft comes from the fallback", async () => {
    const w = await world();
    const r = rig();
    const primary: Generator & { calls: number } = { calls: 0, generate: async () => { primary.calls++; throw new GeneratorError("http_529"); } };
    r.deps.generator = new FailoverGenerator([{ name: "claude", generator: primary }, { name: "claude-fallback", generator: r.generator }], breaker, () => {});
    expect(await runTurn(w.conv.id, r.deps)).toMatchObject({ status: "committed", outcome: "replied" });
    expect(primary.calls).toBeGreaterThan(0);
    expect(await aiMessages(w.conv.id)).toHaveLength(1);
  });
});
