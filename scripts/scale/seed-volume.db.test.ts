import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { assertTestDatabase, seedVolume } from "./seed-volume";

describe("the volume seed", () => {
  test("it refuses a database whose name has no _test_, before connecting", () => {
    for (const url of ["postgres://u:p@h/understudy", "postgres://u:p@h/understudy_dev", "postgres://u:p@h/understudy_testing", undefined]) {
      expect(() => assertTestDatabase(url)).toThrow();
    }
    expect(assertTestDatabase("postgres://u:p@h/understudy_test_main")).toBe("understudy_test_main");
  });

  test("a small run writes the expected rows, and rolls back so other tests see none", async () => {
    // The database in use is the test database, whose name the guard accepts.
    expect(assertTestDatabase(process.env.DATABASE_URL)).toContain("_test_");
    const counts = await db.transaction(async (tx) => {
      const client = { query: async (text: string) => { const r = await tx.execute(text as never); return { rows: r.rows as Record<string, unknown>[], rowCount: r.rowCount }; } };
      await seedVolume(client, { creators: 2, fansPerCreator: 2, messagesPerConversation: 3 });
      const { rows } = await client.query(`select
        (select count(*)::int from creators where handle like 'seed-c%') creators,
        (select count(*)::int from conversations c join creators r on r.id = c.creator_id where r.handle like 'seed-c%') conversations,
        (select count(*)::int from messages m join conversations c on c.id = m.conversation_id join creators r on r.id = c.creator_id where r.handle like 'seed-c%') messages,
        (select count(*)::int from persona_chunks p join creators r on r.id = p.creator_id where r.handle like 'seed-c%') chunks`);
      throw Object.assign(new Error("rollback"), { counts: rows[0] });
    }).catch((e) => {
      if (e.message === "rollback") return e.counts as Record<string, number>;
      throw e;
    });
    expect(counts).toEqual({ creators: 2, conversations: 4, messages: 12, chunks: 80 });
    const { rows } = await db.execute(`select count(*)::int n from creators where handle like 'seed-c%'` as never);
    expect(rows[0]).toEqual({ n: 0 });
  });
});
