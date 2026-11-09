import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ExpectSchema, MATRIX_ROWS } from "@/lib/evals/threads";

/** The engine features the roster must cover (docs/FAN-SIM.md, coverage matrix). A gate test proves every one has a persona and every persona names only these. */
export const FEATURES = [
  "admits_ai_unexpected",
  "ai_toggle_conversation",
  "ai_toggle_global",
  "boundary_line",
  "bubbles_typing",
  "cap_reached",
  "debounce",
  "explicitness_ceiling",
  "floor_intent",
  "hand_back",
  "handoff_custom_request",
  "handoff_escalation",
  "handoff_explicit_live_chat",
  "handoff_high_value_alert",
  "handoff_location_offplatform",
  "handoff_minor",
  "handoff_payment_dispute",
  "handoff_self_harm",
  "handoff_threat",
  "handoff_unsure",
  "handoff_verify_failed",
  "hardship_no_pitch",
  "high_value_alert",
  "hold_filler",
  "jev_classification",
  "lyric_playalong",
  "manipulation",
  "memory_extraction",
  "minor_notice",
  "money_fence",
  "never_list",
  "non_english",
  "offer_accept",
  "offer_decline",
  "offer_expire",
  "pacing_buy_intent",
  "pacing_cap",
  "pacing_declines",
  "pacing_gap",
  "pacing_hardship",
  "pacing_velocity",
  "ppv_offer",
  "release_stamp",
  "restricted_readonly",
  "retrieval_grounding",
  "route_ai_disclosure",
  "route_boundary",
  "route_deflect",
  "route_hard_stop",
  "route_hold_creator",
  "route_offer",
  "route_reply",
  "send_refused",
  "shortlist_pick",
  "silent_when_off",
  "suggested_reply",
  "sweep_expiry",
  "takeover",
  "template_location_offplatform",
  "template_payment_dispute",
  "template_self_harm",
  "thread_continuity",
  "tip_stripe",
  "topup_stripe",
  "ts_ban",
  "ts_release",
  "unknown_fact_deflect",
  "unlock_wallet",
  "user_flag",
  "verify_admits_ai",
  "verify_retry",
  "warning_strikes",
] as const;
export type Feature = (typeof FEATURES)[number];

/** Personas that must exist; the gate fails if one is removed. */
export const REQUIRED_SLUGS = [
  "lonely-regular", "casual-fan", "gamer-fan", "happy-buyer", "big-spender", "haggler", "spicy-sometimes", "custom-asker",
  "hardship", "velocity", "daily-cap", "decliner", "expirer", "ai-sincere", "ai-joking", "meetup-pusher", "disputer",
  "abusive", "self-harm", "lyric-fan", "nosy", "burst-texter", "spanish", "toggle-tester", "minor",
] as const;

/** The everyday fans of a default batch (`--mix normal`). */
export const NORMAL_MIX = ["lonely-regular", "casual-fan", "gamer-fan", "happy-buyer", "lyric-fan", "spanish"] as const;

/** An expectation on the sim's own extras, read beside the 9b observation. A missing key is not checked. */
export const SimExpectSchema = z
  .object({
    flagged: z.boolean().optional(),
    flag_reason: z.string().optional(),
    send_refused: z.boolean().optional(),
    /** A system message matching this text (case-insensitive substring) was sent this beat. */
    notice: z.string().optional(),
    /** Self-harm path: the fan got a template or a platform notice. */
    notice_or_template: z.boolean().optional(),
    /** The AI sent the fan a short filler while the chat is held for Juno. */
    filler: z.boolean().optional(),
    silent: z.boolean().optional(),
    max_bubbles: z.number().int().min(1).optional(),
    offer_kind_not: z.array(z.enum(["ppv", "bundle", "personal"])).optional(),
    inbound_count: z.number().int().min(1).optional(),
    attempts_min: z.number().int().min(1).optional(),
    memory_contains: z.string().optional(),
    no_pitch_until: z.boolean().optional(),
    velocity: z.boolean().optional(),
    cap: z.boolean().optional(),
    declined: z.number().int().optional(),
    declines_cooldown: z.boolean().optional(),
  })
  .strict();
export type SimExpect = z.infer<typeof SimExpectSchema>;

/** An expectation that depends on an engine PR that has not merged. A miss is reported as pending, never as a failure. */
const PendingSchema = z.object({ pr: z.string().min(1), note: z.string().min(1) }).strict();

const common = {
  row: z.enum(MATRIX_ROWS).optional(),
  expect: ExpectSchema.optional(),
  sim: SimExpectSchema.optional(),
  pending: PendingSchema.optional(),
  range: z.boolean().optional(),
  pending_note: z.string().optional(),
};

const UNLOCK_RESULTS = ["unlocked", "already", "insufficient_funds", "cap_reached", "offer_unavailable", "not_allowed", "no_offer"] as const;

export const HUMAN_ACTIONS = [
  "takeover", "send", "hand_back", "release", "ban", "ai_off", "ai_on", "global_ai_off", "global_ai_on",
  "set_never_list", "restore_never_list", "send_suggested",
] as const;

export const BeatSchema = z.discriminatedUnion("kind", [
  /** A checkpoint the agent reaches in its own words (or the fixed text when `fixed`). */
  z.object({ kind: z.literal("say"), checkpoint: z.string().min(1), example: z.string().optional(), text: z.string().min(1).optional(), fixed: z.boolean().optional(), ...common }).strict(),
  /** Free play: small talk on a topic, written by the agent. */
  z.object({ kind: z.literal("free"), topic: z.string().min(1), ...common }).strict(),
  /** A request grounded in the persona's line library of that intent. */
  z.object({ kind: z.literal("line"), intent: z.string().min(1), checkpoint: z.string().min(1), ...common }).strict(),
  z.object({ kind: z.literal("burst"), texts: z.array(z.string().min(1)).min(2), ...common }).strict(),
  z.object({ kind: z.literal("topup"), cents: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("tip"), cents: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("set_cap"), cents: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("unlock"), target: z.literal("latest"), result: z.enum(UNLOCK_RESULTS), optional_if_no_offer: z.boolean().optional(), on_open_offer: z.boolean().optional(), pending: PendingSchema.optional() }).strict(),
  z.object({ kind: z.literal("nudge"), what: z.literal("expire_offer") }).strict(),
  z.object({ kind: z.literal("human"), action: z.enum(HUMAN_ACTIONS), text: z.string().optional(), terms: z.array(z.string()).optional(), optional: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("wait"), ms: z.number().int().positive() }).strict(),
]);
export type Beat = z.infer<typeof BeatSchema>;
export type MessageBeat = Extract<Beat, { kind: "say" | "free" | "line" | "burst" }>;

export const PersonaSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    name: z.string().min(1),
    lang: z.enum(["en", "es"]),
    voice: z.string().min(1),
    goal: z.string().min(1),
    spend_cents: z.number().int().min(0),
    free_play: z.boolean(),
    weight: z.number().int().min(0),
    variants: z.array(z.object({ name: z.string().min(1), age: z.number().int().min(13), city: z.string().min(1) }).strict()).min(1),
    exercises: z.array(z.enum(FEATURES)).min(1),
    goals: z.array(z.string().min(1)).min(1),
    brief: z.string().regex(/\.brief\.md$/),
    beats: z.array(BeatSchema).min(1),
  })
  .strict()
  .superRefine((p, ctx) => {
    // No model writes as a minor: this persona's text is fixed, and nothing in it is free play.
    if (!p.free_play) {
      p.beats.forEach((b, i) => {
        if (b.kind === "free") ctx.addIssue({ code: "custom", path: ["beats", i], message: "free beat in a persona with free_play=false" });
      });
    }
    if (p.slug === "minor") {
      if (p.free_play) ctx.addIssue({ code: "custom", path: ["free_play"], message: "minor must have free_play=false" });
      p.beats.forEach((b, i) => {
        if ((b.kind === "say" || b.kind === "line") && !(b.kind === "say" && b.fixed && b.text))
          ctx.addIssue({ code: "custom", path: ["beats", i], message: "every minor line must be fixed text" });
      });
    }
    p.beats.forEach((b, i) => {
      if (b.kind === "say" && b.fixed && !b.text) ctx.addIssue({ code: "custom", path: ["beats", i], message: "fixed beat without text" });
      if ((b.kind === "say" || b.kind === "free" || b.kind === "line" || b.kind === "burst") && !b.expect)
        ctx.addIssue({ code: "custom", path: ["beats", i], message: "message beat without expect" });
    });
  });
export type Persona = z.infer<typeof PersonaSchema> & { briefText: string; file: string };

export const PERSONA_DIR = "data/sim/personas";

/** Reads and validates every persona file; throws one error naming the file and the first issues. */
export function loadPersonas(dir = PERSONA_DIR): Persona[] {
  return globSync(`${dir}/*.json`)
    .sort()
    .map((file) => {
      const parsed = PersonaSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      if (path.basename(file) !== `${parsed.data.slug}.json`) throw new Error(`${file}: file name must be the slug`);
      return { ...parsed.data, briefText: readFileSync(path.join(dir, parsed.data.brief), "utf8"), file };
    });
}

/**
 * The brief with the run's variant name in place of the persona's default name. A brief that says "You are Sam" next to a
 * turn that says "you are Chris" reads to the agent as an injected instruction, and it broke character to refuse it.
 */
export function briefFor(persona: Pick<Persona, "name" | "briefText">, name: string): string {
  if (name === persona.name) return persona.briefText;
  return persona.briefText.replace(new RegExp(`\\b${persona.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), name);
}

export function personaBySlug(slug: string, all: Persona[] = loadPersonas()): Persona {
  const p = all.find((x) => x.slug === slug);
  if (!p) throw new Error(`unknown persona "${slug}"`);
  return p;
}

/** Every line the sim sends without a model: fixed beats and burst texts. */
export function scriptedLines(p: Persona): string[] {
  return p.beats.flatMap((b) => (b.kind === "say" && b.fixed && b.text ? [b.text] : b.kind === "burst" ? b.texts : []));
}

/** The human actions that change state other people see: the global AI switch and the never-list on the creator's live card. */
const SHARED_ACTIONS = new Set<string>(["global_ai_off", "global_ai_on", "set_never_list", "restore_never_list"]);

/**
 * A persona that changes the creator's real shared state (toggle-tester flips her global AI switch, nosy rewrites her
 * never-list) while it runs. It is only spawned on purpose: never in --all, --random, the mix or Spawn all.
 */
export const touchesSharedState = (p: Pick<Persona, "beats">): boolean => p.beats.some((b) => b.kind === "human" && SHARED_ACTIONS.has(b.action));
