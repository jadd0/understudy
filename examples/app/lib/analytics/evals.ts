import { readFile } from "node:fs/promises";
import path from "node:path";

/** docs/quality/evals/persona.json, written by the persona eval: rubric means and the blind test. */
export interface PersonaEval {
  /** Rubric criterion to mean score, 1 to 5. */
  rubric?: Record<string, number>;
  blindTest?: { accuracy?: number; low?: number; high?: number; n?: number };
}

/** docs/quality/evals/engine.json, written by the engine eval: safety, handoff and route accuracy. */
export interface EngineEval {
  safetyViolations?: number;
  /** Per queue (creator, ts). */
  handoff?: Record<string, { precision?: number; recall?: number }>;
  routeAccuracy?: number;
}

export interface Evals {
  persona: PersonaEval | null;
  engine: EngineEval | null;
}

async function readJson<T>(root: string, file: string): Promise<T | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(root, "docs/quality/evals", file), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as T) : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") console.error(`analytics: ${file} unreadable ${(e as Error)?.name}`);
    return null;
  }
}

/** Each file is null until its eval has run; the dashboard then shows "not run" for that file's tiles. */
export async function readEvals(root = process.cwd()): Promise<Evals> {
  const [persona, engine] = await Promise.all([readJson<PersonaEval>(root, "persona.json"), readJson<EngineEval>(root, "engine.json")]);
  return { persona, engine };
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The mean of the rubric's criteria, or undefined with none. */
export function rubricMean(p: PersonaEval | null): number | undefined {
  const vals = Object.values(p?.rubric ?? {}).filter(finite);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined;
}

/** Mean precision or recall across the queues that reported it. */
export function handoffMean(e: EngineEval | null, k: "precision" | "recall"): number | undefined {
  const vals = Object.values(e?.handoff ?? {}).map((q) => q?.[k]).filter(finite);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined;
}
