import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { ENGINE_CONFIG, SIM_CONFIG } from "@/db/seed";
import { FLIRT, GRAPHIC } from "./guard";
import { readLines } from "./lines";
import { briefFor, FEATURES, loadPersonas, PersonaSchema, REQUIRED_SLUGS, scriptedLines } from "./persona";

const personas = loadPersonas();

describe("persona files", () => {
  test("all_persona_files_validate", () => {
    expect(personas.length).toBeGreaterThanOrEqual(REQUIRED_SLUGS.length);
    for (const p of personas) expect(p.briefText.length, p.slug).toBeGreaterThan(50);
  });

  test("slugs_unique_and_required_slugs_present", () => {
    const slugs = personas.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect([...REQUIRED_SLUGS].filter((s) => !slugs.includes(s))).toEqual([]);
  });

  test("minor_has_no_free_beats", () => {
    const minor = personas.find((p) => p.slug === "minor")!;
    expect(minor.free_play).toBe(false);
    expect(minor.weight).toBe(0);
    expect(minor.beats.filter((b) => b.kind === "say" || b.kind === "line" || b.kind === "free").length).toBeGreaterThan(0);
    expect(minor.beats.filter((b) => b.kind === "free" || b.kind === "line")).toEqual([]);
    expect(minor.beats.filter((b) => b.kind === "say").every((b) => b.kind === "say" && b.fixed === true && Boolean(b.text))).toBe(true);
    // the schema itself refuses a free beat or a model-written line for the minor
    const bad = { ...JSON.parse(readFileSync("data/sim/personas/minor.json", "utf8")), beats: [{ kind: "free", topic: "chat", expect: { queue: "none" } }] };
    expect(PersonaSchema.safeParse(bad).success).toBe(false);
    const unfixed = { ...JSON.parse(readFileSync("data/sim/personas/minor.json", "utf8")), beats: [{ kind: "say", checkpoint: "hi", example: "hi", expect: { queue: "none" } }] };
    expect(PersonaSchema.safeParse(unfixed).success).toBe(false);
  });

  test("minor_lines_pass_graphic_and_flirt_fence", () => {
    const minor = personas.find((p) => p.slug === "minor")!;
    const lines = scriptedLines(minor);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.filter((l) => GRAPHIC.test(l) || FLIRT.test(l))).toEqual([]);
    const library = readLines().filter((l) => l.persona === "minor");
    expect(library.length).toBeGreaterThan(0);
    expect(library.filter((l) => GRAPHIC.test(l.text) || FLIRT.test(l.text))).toEqual([]);
    // the fence can fail: a flirt word and a graphic word are both caught
    expect(FLIRT.test("ur so pretty")).toBe(true);
    expect(GRAPHIC.test("send nudes")).toBe(true);
  });

  test("explicit_library_is_not_graphic", () => {
    const lines = readLines();
    expect(lines.length).toBeGreaterThan(100);
    expect(lines.filter((l) => GRAPHIC.test(l.text)).map((l) => l.text)).toEqual([]);
    const asks = lines.filter((l) => l.intent === "explicit_request");
    expect(asks.length).toBeGreaterThan(0);
    for (const p of personas) for (const l of scriptedLines(p)) expect(GRAPHIC.test(l), `${p.slug}: ${l}`).toBe(false);
    // every persona has lines of its own in its own language
    for (const p of personas) {
      const own = lines.filter((l) => l.persona === p.slug);
      expect(own.length, p.slug).toBeGreaterThanOrEqual(3);
      expect(own.every((l) => l.lang === p.lang), p.slug).toBe(true);
    }
  });

  test("features_all_covered", () => {
    const covered = new Set(personas.flatMap((p) => p.exercises));
    expect([...FEATURES].filter((f) => !covered.has(f))).toEqual([]);
    expect([...covered].filter((f) => !(FEATURES as readonly string[]).includes(f))).toEqual([]);
  });

  test("burst_gap_under_debounce", () => {
    const bursts = personas.flatMap((p) => p.beats.filter((b) => b.kind === "burst"));
    expect(bursts.length).toBeGreaterThan(0);
    for (const b of bursts) {
      if (b.kind !== "burst") continue;
      expect((SIM_CONFIG["sim.burst_gap_ms"] as number) * (b.texts.length - 1)).toBeLessThan(ENGINE_CONFIG["engine.debounce_ms"] as number);
    }
  });

  test("every_row_named_is_a_matrix_row_and_pending_beats_say_which_pr", () => {
    const pending = personas.flatMap((p) => p.beats.flatMap((b) => ("pending" in b && b.pending ? [b.pending] : [])));
    expect(pending.length).toBeGreaterThan(0);
    expect([...new Set(pending.map((x) => x.pr))].sort()).toEqual(["4c"]);
  });
});

describe("briefFor", () => {
  test("every brief carries the run's variant name and never the default one", () => {
    for (const p of personas) {
      for (const v of p.variants) {
        const brief = briefFor(p, v.name);
        if (v.name !== p.name) expect(brief, `${p.slug} as ${v.name}`).not.toMatch(new RegExp(`\\b${p.name}\\b`));
        if (p.briefText.includes(p.name)) expect(brief).toContain(v.name);
      }
    }
  });
});
