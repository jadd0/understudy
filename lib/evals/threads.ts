import { readFileSync, globSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { THREADS } from "@/lib/engine/types";

/**
 * The rows of the routing matrix in docs/SAFETY.md, in table order. A thread turn names the row it exercises;
 * the thread test fails if the table gains or loses a row without this list following.
 */
export const MATRIX_ROWS = [
  "smalltalk",
  "flirt",
  "buy_intent",
  "explicit_request",
  "ai_question",
  "manipulation",
  "live_chat",
  "custom_request",
  "high_value",
  "location_offplatform",
  "minor",
  "self_harm",
  "threat",
  "payment_dispute",
  "hardship",
  "unsure",
] as const;
export type MatrixRow = (typeof MATRIX_ROWS)[number];

export const ROUTE_NAMES = ["reply", "offer", "hold_creator", "hard_stop", "deflect", "ai_disclosure"] as const;
export type RouteName = (typeof ROUTE_NAMES)[number];

const route = z.enum(ROUTE_NAMES);
const thread = z.enum([...THREADS, "unknown"]);

/** What one fan turn must produce. A missing field means "not checked" (queue: use "any"). */
export const ExpectSchema = z
  .object({
    /** The route the turn takes: one name, or any of a set. */
    route: z.union([route, z.array(route).min(1)]).optional(),
    /** Who owns the conversation after the turn: nobody, Juno's queue, or Trust & Safety. */
    queue: z.enum(["none", "creator", "ts", "any"]),
    /** An offer was put in front of the fan this turn. */
    offer: z.enum(["yes", "no", "any"]).optional(),
    /** Regular expressions (case-insensitive) no delivered AI reply may match. */
    must_not: z.array(z.string().min(1)).optional(),
    /** The fan asked sincerely whether she is an AI (true), or the reply must not volunteer it (false). */
    admits_ai: z.boolean().optional(),
    /** The AI sends nothing this turn because a human or Trust & Safety already owns the conversation. */
    silent: z.boolean().optional(),
    /** A high-value alert is open for the creator after this turn. */
    alert: z.boolean().optional(),
    /** How many engine turns the fan's messages produce (default 1; 0 when silent). */
    turns: z.number().int().min(0).optional(),
    /** Jev's reading of how his messages fit the chat: one answer, or any of a set. */
    thread: z.union([thread, z.array(thread).min(1)]).optional(),
    /** The catalogue kinds of the offers made this turn: each must be one of these. */
    offer_kinds: z.array(z.enum(["ppv", "bundle", "personal"])).min(1).optional(),
    /** At least one AI reply reached the fan (yes), or none did (no). */
    reply: z.enum(["yes", "no"]).optional(),
  })
  .strict();
export type Expect = z.infer<typeof ExpectSchema>;

export const TurnSchema = z
  .object({
    /** Fan messages sent back to back before the engine runs; more than one is a burst. */
    say: z.array(z.string().min(1).max(2000)).min(1),
    /** Fan messages sent while the engine is already working on the first, each `after_ms` after it starts. */
    say_later: z.array(z.object({ after_ms: z.number().int().min(1).max(30000), text: z.string().min(1).max(2000) }).strict()).optional(),
    /** The chat so far (history and earlier turns) is moved this many minutes into the past before the turn is sent. */
    after_minutes: z.number().min(1).optional(),
    /** The matrix row this turn tests. Route accuracy is reported per row over the turns that name one. */
    row: z.enum(MATRIX_ROWS).optional(),
    expect: ExpectSchema,
  })
  .strict();
export type ThreadTurn = z.infer<typeof TurnSchema>;

/** State the fan arrives with, built through the wallet's own primitives. */
export const SetupSchema = z
  .object({
    /** Fan holds this balance. */
    wallet_cents: z.number().int().min(0).optional(),
    /** Fan has spent up to their own daily cap today. */
    at_cap: z.boolean().optional(),
    /** Unlocks in the velocity window (small ones). */
    recent_unlocks: z.number().int().min(1).max(10).optional(),
    /** Fan has spent past the high-value threshold. */
    high_value: z.boolean().optional(),
    /** Earlier chat, oldest first. Nothing in it is waiting for an answer. */
    history: z.array(z.object({ from: z.enum(["fan", "her"]), text: z.string().min(1), minutes_ago: z.number().min(0) }).strict()).min(1).optional(),
  })
  .strict();
export type Setup = z.infer<typeof SetupSchema>;

export const ThreadSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    title: z.string().min(1),
    setup: SetupSchema.optional(),
    turns: z.array(TurnSchema).min(1),
  })
  .strict();
export type Thread = z.infer<typeof ThreadSchema>;

export const threadJsonSchema = () => z.toJSONSchema(ThreadSchema);

/** Every row a thread's turns exercise. */
export const rowsOf = (t: Thread): MatrixRow[] => [...new Set(t.turns.flatMap((x) => (x.row ? [x.row] : [])))];

export function loadThreads(pattern = "data/evals/threads/*.json"): Thread[] {
  return globSync(pattern)
    .sort()
    .map((file) => {
      const parsed = ThreadSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      if (path.basename(file) !== `${parsed.data.id}.json`) throw new Error(`${file}: file name must be the thread id`);
      return parsed.data;
    });
}
