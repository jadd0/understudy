import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { MATRIX_ROWS, loadThreads, rowsOf, threadJsonSchema } from "./threads";

const threads = loadThreads();

/** First cell and last cell of each row in the table under "## Routing matrix" of docs/SAFETY.md. */
function matrixTable() {
  const doc = readFileSync("docs/SAFETY.md", "utf8");
  const section = doc.split("## Routing matrix")[1].split("\n**Rules**")[0];
  const lines = section.split("\n").filter((l) => l.startsWith("|"));
  const header = lines[0].split("|").slice(1, -1).map((c) => c.trim());
  return { header, rows: lines.slice(2).map((l) => l.split("|").slice(1, -1).map((c) => c.trim())) };
}

describe("thread bank", () => {
  test("all_threads_validate", () => {
    expect(threads.length).toBeGreaterThanOrEqual(40);
    for (const t of threads) {
      for (const turn of t.turns) {
        for (const p of turn.expect.must_not ?? []) expect(() => new RegExp(p, "i"), `${t.id} must_not ${p}`).not.toThrow();
        if (turn.expect.silent) expect(turn.expect.turns ?? 0, `${t.id} silent turn runs nothing`).toBe(0);
      }
    }
  });

  test("schema_file_is_the_zod_schema", () => {
    expect(JSON.parse(readFileSync("data/evals/threads.schema.json", "utf8"))).toEqual(JSON.parse(JSON.stringify(threadJsonSchema())));
  });

  test("no_duplicate_ids", () => {
    const ids = threads.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every_matrix_row_has_a_thread", () => {
    const { header, rows } = matrixTable();
    // Sixteen rows today. A row added to the table must be added to MATRIX_ROWS, or this fails.
    expect(rows.length).toBe(MATRIX_ROWS.length);
    expect(rows.length).toBe(16);
    const col = header.indexOf("Threads");
    expect(col, "SAFETY.md matrix has a Threads column").toBeGreaterThan(0);

    const byId = new Map(threads.map((t) => [t.id, t]));
    rows.forEach((cells, i) => {
      const row = MATRIX_ROWS[i];
      const listed = cells[col].match(/`([a-z0-9-]+)`/g)?.map((s) => s.slice(1, -1)) ?? [];
      expect(listed.length, `matrix row ${i + 1} (${row}) lists a thread`).toBeGreaterThan(0);
      for (const id of listed) {
        const thread = byId.get(id);
        expect(thread, `${id} exists`).toBeDefined();
        expect(rowsOf(thread!), `${id} exercises ${row}`).toContain(row);
      }
      const covering = threads.filter((t) => rowsOf(t).includes(row)).map((t) => t.id).sort();
      expect([...listed].sort(), `SAFETY.md lists every thread covering ${row}`).toEqual(covering);
    });
  });

  test("safety_rows_are_expected_to_hard_stop", () => {
    // A safety thread that expects the AI to carry on would make the bar vacuous.
    for (const row of ["minor", "self_harm", "threat", "payment_dispute"] as const) {
      const tagged = threads.flatMap((t) => t.turns.filter((x) => x.row === row));
      expect(tagged.length, row).toBeGreaterThan(0);
      for (const turn of tagged) expect(turn.expect.queue, row).toBe("ts");
    }
    // A meetup or off-platform ask is a strike: her boundary line, and the AI keeps chatting.
    const asks = threads.flatMap((t) => t.turns.filter((x) => x.row === "location_offplatform"));
    expect(asks.length).toBeGreaterThan(0);
    for (const turn of asks) expect([turn.expect.route, turn.expect.queue]).toEqual(["boundary", "none"]);
  });

  test("convo_threads_parse", () => {
    const convo = threads.filter((t) => t.id.startsWith("convo-"));
    expect(convo.map((t) => t.id).sort()).toEqual([
      "convo-asked-back-plans",
      "convo-flowing-flirt",
      "convo-greeting-after-gap",
      "convo-reask-answered",
      "convo-returning-hours",
      "convo-split-complete-then-more",
      "convo-split-unfinished",
    ]);
    // the conversation fields are really used by the set
    expect(convo.some((t) => (t.setup?.history?.length ?? 0) > 0)).toBe(true);
    expect(convo.some((t) => t.turns.some((x) => (x.say_later?.length ?? 0) > 0))).toBe(true);
    expect(convo.some((t) => t.turns.some((x) => x.expect.thread !== undefined))).toBe(true);
    expect(convo.some((t) => t.turns.some((x) => x.expect.offer_kinds !== undefined))).toBe(true);
    for (const t of convo) {
      // history is listed oldest first, so minutes_ago never increases down the list
      const ago = (t.setup?.history ?? []).map((h) => h.minutes_ago);
      expect(ago, t.id).toEqual([...ago].sort((a, b) => b - a));
    }
  });
});
