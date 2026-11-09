import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { engineDrafter } from "./eval-persona";
// @ts-expect-error the persona package is plain .mjs without declarations for its internals
import { evalPersona, retrieveChunks, trainChunks } from "../../../../packages/persona/src/eval-persona.mjs";
// @ts-expect-error plain .mjs
import { TokenBudget } from "../../../../packages/persona/src/lib/io.mjs";

const CARD = "## Identity\n- Juno, streamer. Biscuit is her greyhound.\n## Voice rules\n- short, lowercase\n";
const rows = Array.from({ length: 4 }, (_, i) => ({ id: `test${i}`, post_shortcode: `P${i}`, text: `@fan hers ${i}`, replying_to: `do you like the Brighton pier ${i}` }));

function bank(markers: Record<string, unknown> | null) {
  const dir = mkdtempSync(join(tmpdir(), "eval-engine-"));
  const bankDir = join(dir, "bank");
  const cardDir = join(dir, "card");
  mkdirSync(bankDir);
  mkdirSync(cardDir);
  const lines = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join("\n") + "\n";
  writeFileSync(join(bankDir, "replies.jsonl"), lines(rows));
  writeFileSync(join(bankDir, "splits.json"), JSON.stringify({ replies: { train: [], validation: [], test: rows.map((r) => r.id), style_only: [] } }));
  writeFileSync(join(bankDir, "profile.json"), JSON.stringify({ display_name: "juno" }));
  writeFileSync(
    join(bankDir, "chunks.jsonl"),
    lines([
      { id: "c1", source: "caption", split: null, text: "the Brighton pier at dawn" },
      { id: "c2", source: "comment_reply", split: "train", text: "pier chips are the best" },
      { id: "c3", source: "comment_reply", split: "test", text: "HELD OUT pier line" },
      { id: "c4", source: "caption", split: null, text: "nothing relevant" },
    ]),
  );
  if (markers) writeFileSync(join(bankDir, "style.json"), JSON.stringify({ markers }));
  writeFileSync(join(cardDir, "v2.md"), CARD);
  return { bankDir, cardDir, markers };
}

const blind = JSON.stringify({ author: "A", confidence: 0.7, reason: "feels hers" });
const rubric = JSON.stringify({ voice: { score: 4, reason: "r" }, fact_consistency: { score: 4, reason: "r" }, natural_pitch: { score: "na", reason: "r" } });

function fakeClaude() {
  const calls: { system: string; prompt: string }[] = [];
  return {
    calls,
    complete: async (call: { system: string; prompt: string }) => {
      calls.push(call);
      const text = call.system.startsWith("You are a strict evaluator") ? rubric : call.system.startsWith("You are shown") ? blind : "ha proper tired mate x";
      return { text, usage: { input_tokens: 10, output_tokens: 5 } };
    },
  };
}

const RATES = { n: 100, pet: "biscuit", signoff_x: 0, mate: 0, babe: 0, pet_name: 0, emoji: 0, concrete_fact: 0.1 };

describe("the persona eval drafts through the engine", () => {
  test("the generator sees the engine's prompt with the card, the draw block and train-only retrieved lines, and the reply is cleaned", async () => {
    const b = bank(RATES);
    const claude = fakeClaude();
    const dirs = { bankDir: b.bankDir, cardDir: b.cardDir };
    const result = await evalPersona({ ...dirs, version: 2, claude, genModel: "g", judgeModel: "j", seed: "s", budget: new TokenBudget(), drafter: engineDrafter({ rates: b.markers, chunks: trainChunks(b.bankDir), seed: "s" }) });
    const gen = claude.calls.filter((c) => !c.system.startsWith("You are a strict") && !c.system.startsWith("You are shown"));
    expect(gen).toHaveLength(4);
    for (const call of gen) {
      expect(call.system).toContain("Juno, streamer");
      expect(call.system).toContain("## How you answer");
      expect(call.system).toContain("## Voice for this reply");
      expect(call.system).toContain("No sign-off");
      expect(call.system).toContain("the Brighton pier at dawn");
      expect(call.system).toContain("pier chips are the best");
      expect(call.system).not.toContain("HELD OUT");
      expect(call.prompt).toContain("do you like the Brighton pier");
    }
    // the model echoed a sign-off and "mate"; the draw disallowed both, so the bot's reply has neither
    expect(result.items.map((i: { generated: string }) => i.generated)).toEqual(Array(4).fill("ha proper tired"));
    expect(result.items.every((i: { draw: unknown }) => i.draw !== null)).toBe(true);
    const sign = result.aggregate.markers.rates.signoff_x;
    expect(sign).toEqual({ train: 0, real: 0, bot: 0 });
  });

  test("a bank without markers drafts without a draw block and leaves the reply as written", async () => {
    const b = bank(null);
    const claude = fakeClaude();
    const dirs = { bankDir: b.bankDir, cardDir: b.cardDir };
    const result = await evalPersona({ ...dirs, version: 2, claude, genModel: "g", judgeModel: "j", seed: "s", budget: new TokenBudget(), drafter: engineDrafter({ rates: b.markers, chunks: trainChunks(b.bankDir), seed: "s" }) });
    const gen = claude.calls.filter((c) => !c.system.startsWith("You are a strict") && !c.system.startsWith("You are shown"));
    expect(gen.every((c) => !c.system.includes("Voice for this reply"))).toBe(true);
    expect(result.items[0].generated).toBe("ha proper tired mate x");
  });
});

describe("retrieveChunks", () => {
  test("ranks by shared words and returns nothing when none are shared", () => {
    const chunks = [
      { id: "a", text: "pier chips" },
      { id: "b", text: "rainy day" },
    ];
    expect(retrieveChunks(chunks, "the pier?", 5).map((c: { id: string }) => c.id)).toEqual(["a"]);
    expect(retrieveChunks(chunks, "zzz", 5)).toEqual([]);
  });
});
