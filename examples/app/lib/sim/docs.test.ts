import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { SIM_CONFIG } from "@/db/seed";
import { FAN_SIM_DOC, REGIONS, regionOf, renderRegion, SHOWN_IN } from "./docs";
import { FEATURES, loadPersonas, touchesSharedState } from "./persona";
import { parseArgs, Usage } from "../../scripts/sim/run";

const doc = readFileSync(FAN_SIM_DOC, "utf8");
const personas = loadPersonas();

const SECTIONS = [
  "## 1. What it is and why",
  "## 2. Quick start",
  "## 3. Every persona",
  "## 4. Coverage matrix",
  "## 5. Spawning",
  "## 6. Safety of the sim itself",
  "## 7. Money",
  "## 8. Run lifecycle",
  "## 9. Reading results",
  "## 10. Every prompt verbatim",
  "## 10a. The sim agent and its RAG",
  "## 11. Config rows",
  "## 12. Troubleshooting",
  "## 13. Adding a persona",
];

describe("docs/FAN-SIM.md", () => {
  test("fan_sim_doc_has_every_section_and_persona", () => {
    for (const s of SECTIONS) expect(doc, s).toContain(`\n${s}\n`);
    expect(personas.length).toBeGreaterThanOrEqual(25);
    for (const p of personas) expect(doc, p.slug).toContain(`\n### \`${p.slug}\`\n`);
    // every config row, every CLI flag and every action name the manual explains
    for (const key of Object.keys(SIM_CONFIG)) expect(doc, key).toContain(`\`${key}\``);
    for (const flag of ["--persona", "--mix", "--random", "--seed", "--include-minor", "--include-shared", "--all", "--mode", "--stop", "--reset", "--export", "--list", "--docs"]) {
      expect(doc, flag).toContain(`\`${flag}`);
    }
    for (const state of ["queued", "running", "waiting_human", "done", "stopped", "failed"]) expect(doc, state).toContain(state);
    expect(doc.match(/```mermaid/g)?.length).toBeGreaterThanOrEqual(3);
  });

  test("generated regions are current (npm run sim -- --docs regenerates them)", () => {
    for (const r of REGIONS) {
      expect(regionOf(doc, r), r).toBe(renderRegion(r, personas).trim());
    }
  });

  test("every feature has a place on screen", () => {
    expect(Object.keys(SHOWN_IN).sort()).toEqual([...FEATURES].sort());
    for (const f of FEATURES) expect(regionOf(doc, "coverage"), f).toContain(`\`${f}\``);
  });

  test("the prompts quoted are the sim agent's, and the README lists the doc", () => {
    const blocks = [...doc.matchAll(/<!-- prompt-src: (\S+) -->\n```text\n([\s\S]*?)\n```/g)];
    expect(blocks.length).toBeGreaterThanOrEqual(7);
    const sources = new Set(blocks.map((b) => b[1]));
    expect([...sources].sort()).toEqual(["lib/sim/agent.ts", "lib/sim/prompt.ts", "packages/engine/src/questions.ts"]);
    expect(blocks.some((b) => b[2].startsWith("You are acting as a fan in a text chat"))).toBe(true);
    expect(readFileSync("docs/README.md", "utf8")).toContain("[FAN-SIM.md](FAN-SIM.md)");
    expect(readFileSync("docs/SAFETY.md", "utf8")).toContain("FAN-SIM.md");
  });
});

describe("sim CLI flags", () => {
  test("parseArgs maps flags to plans and refuses nonsense", () => {
    expect(parseArgs(["--persona", "minor"], personas)).toEqual({ kind: "spawn", personas: ["minor"], mode: "auto", seed: undefined, includeShared: false });
    expect(parseArgs(["--mix", "normal", "--mode", "demo"], personas)).toMatchObject({ mode: "demo", personas: expect.arrayContaining(["lonely-regular", "spanish"]) });
    const rnd = parseArgs(["--random", "4", "--seed", "x"], personas);
    expect(rnd).toMatchObject({ kind: "spawn", seed: "x" });
    expect(rnd.kind === "spawn" && rnd.personas).toHaveLength(4);
    expect(rnd.kind === "spawn" && rnd.personas.includes("minor")).toBe(false);
    expect(parseArgs(["--all"], personas)).toMatchObject({ kind: "spawn" });
    expect((parseArgs(["--all"], personas) as { personas: string[] }).personas).toHaveLength(personas.length - 2);
    expect(parseArgs(["--stop"], personas)).toEqual({ kind: "stop", runId: undefined });
    expect(parseArgs(["--stop", "r1"], personas)).toEqual({ kind: "stop", runId: "r1" });
    expect(parseArgs(["--reset"], personas)).toEqual({ kind: "reset" });
    expect(parseArgs(["--export", "all"], personas)).toEqual({ kind: "export", target: "all" });
    // personas that change Juno's real shared state are never in a default batch, and need the flag to run at all
    const shared = personas.filter((p) => touchesSharedState(p)).map((p) => p.slug);
    expect(shared.sort()).toEqual(["nosy", "toggle-tester"]);
    expect(() => parseArgs(["--persona", "toggle-tester"], personas)).toThrow(/--include-shared/);
    expect(parseArgs(["--persona", "nosy", "--include-shared"], personas)).toMatchObject({ personas: ["nosy"], includeShared: true });
    const all = parseArgs(["--all"], personas) as { personas: string[] };
    expect(all.personas.some((s) => shared.includes(s))).toBe(false);
    expect((parseArgs(["--all", "--include-shared"], personas) as { personas: string[] }).personas).toHaveLength(personas.length);
    const many = parseArgs(["--random", "50", "--seed", "z"], personas) as { personas: string[] };
    expect(many.personas.some((s) => shared.includes(s))).toBe(false);
    expect(() => parseArgs([], personas)).toThrow(Usage);
    expect(() => parseArgs(["--persona", "nobody"], personas)).toThrow(/unknown persona/);
    expect(() => parseArgs(["--persona", "minor", "--mode", "sideways"], personas)).toThrow(Usage);
    expect(() => parseArgs(["--random", "0"], personas)).toThrow(Usage);
    expect(() => parseArgs(["--mix", "weird"], personas)).toThrow(Usage);
  });
});
