import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ThreadSchema, type Setup, type Thread, type ThreadTurn } from "@/lib/evals/threads";
import type { Persona } from "./persona";
import type { BeatResult } from "./score";

export const THREAD_DIR = "data/evals/threads";

/**
 * A finished run as a 9b eval thread, so the same conversation can be replayed against the engine and scored by
 * lib/evals/score.ts. Messages and bursts become turns (`say`); top-ups before the cut become the fan's starting
 * wallet. Anything the thread format cannot express (an unlock, a tip, a cap, a human action, a clock nudge) ends the
 * thread, as does a line that was blocked or never sent: a thread that skipped a turn would test a different chat.
 * Returns null when nothing is exportable.
 */
export function exportThread(persona: Persona, results: readonly BeatResult[]): Thread | null {
  const byIndex = new Map(results.map((r) => [r.index, r]));
  const turns: ThreadTurn[] = [];
  const setup: Setup = {};
  for (const [i, beat] of persona.beats.entries()) {
    const r = byIndex.get(i);
    if (!r) break;
    if (beat.kind === "topup") {
      setup.wallet_cents = (setup.wallet_cents ?? 0) + beat.cents;
      continue;
    }
    if (beat.kind === "say" || beat.kind === "free" || beat.kind === "line" || beat.kind === "burst") {
      if (!r.sent?.length || r.status === "blocked" || r.status === "refused" || r.status === "skipped") break;
      turns.push({ say: r.sent, ...(beat.row ? { row: beat.row } : {}), expect: beat.expect! });
      continue;
    }
    break;
  }
  if (turns.length === 0) return null;
  return ThreadSchema.parse({
    id: `sim-${persona.slug}`,
    title: `Sim fan ${persona.slug}: ${persona.goal}`,
    ...(Object.keys(setup).length ? { setup } : {}),
    turns,
  });
}

export function writeThread(thread: Thread, dir = THREAD_DIR): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${thread.id}.json`);
  writeFileSync(file, JSON.stringify(thread, null, 2) + "\n");
  return file;
}
