import { readFileSync, writeFileSync } from "node:fs";
import type { Expect } from "@/lib/evals/threads";
import { FEATURES, type Beat, type Persona } from "./persona";
import { labelOf } from "./beats";

export const FAN_SIM_DOC = "docs/FAN-SIM.md";

/** The generated regions of docs/FAN-SIM.md: a test regenerates them and fails on any difference. */
export const REGIONS = ["coverage", "personas"] as const;
export type Region = (typeof REGIONS)[number];

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** Engine feature → personas → where it shows. The "where" column is hand-kept in SHOWN_IN; a feature missing from it is a doc test failure. */
export const SHOWN_IN: Record<(typeof FEATURES)[number], string> = {
  admits_ai_unexpected: "turn explorer verify trail",
  ai_toggle_conversation: "console conversation settings",
  ai_toggle_global: "console settings",
  boundary_line: "fan chat (boundary line)",
  bubbles_typing: "fan chat live, deliver_at",
  cap_reached: "fan wallet, CapReached",
  debounce: "turn explorer (one turn, N inbound)",
  explicitness_ceiling: "turn explorer jev_in explicitness",
  floor_intent: "turn explorer jev_in floors",
  hand_back: "console, hand-back stamp",
  handoff_custom_request: "console inbox badge",
  handoff_escalation: "console inbox (alert row escalated)",
  handoff_explicit_live_chat: "console inbox badge",
  handoff_high_value_alert: "console badge, top fans tile",
  handoff_location_offplatform: "T&S queue",
  handoff_minor: "T&S queue",
  handoff_payment_dispute: "T&S queue",
  handoff_self_harm: "T&S queue",
  handoff_threat: "T&S queue",
  handoff_unsure: "console inbox badge",
  handoff_verify_failed: "console inbox, suggested card",
  hardship_no_pitch: "responsible-monetisation report",
  high_value_alert: "console badge, top fans tile",
  hold_filler: "fan chat (filler while held)",
  jev_classification: "turn explorer jev_in",
  lyric_playalong: "fan chat",
  manipulation: "turn explorer, deflect",
  memory_extraction: "turn explorer, prompt What she knows",
  minor_notice: "fan chat (platform notice)",
  money_fence: "analytics reply violations (none expected)",
  never_list: "console settings",
  non_english: "turn explorer",
  offer_accept: "offer funnel, fan LockedCard",
  offer_decline: "offer funnel",
  offer_expire: "offer funnel, sweep",
  pacing_buy_intent: "responsible-monetisation report",
  pacing_cap: "responsible-monetisation report",
  pacing_declines: "responsible-monetisation report",
  pacing_gap: "responsible-monetisation report",
  pacing_hardship: "responsible-monetisation report",
  pacing_velocity: "responsible-monetisation report",
  ppv_offer: "fan LockedCard",
  release_stamp: "console, waiting message stamped",
  restricted_readonly: "fan chat (history readable, composer off)",
  retrieval_grounding: "turn explorer, chunks used",
  route_ai_disclosure: "analytics route mix",
  route_boundary: "analytics route mix, T&S queue",
  route_deflect: "analytics route mix",
  route_hard_stop: "analytics route mix, T&S queue",
  route_hold_creator: "analytics route mix, console",
  route_offer: "analytics route mix, offer funnel",
  route_reply: "analytics route mix",
  send_refused: "fan chat (send refused)",
  shortlist_pick: "turn explorer offer pick",
  silent_when_off: "console, no reply",
  suggested_reply: "console suggested card",
  sweep_expiry: "offer funnel, expiry sweep",
  takeover: "console",
  template_payment_dispute: "fan chat",
  template_self_harm: "fan chat",
  thread_continuity: "turn explorer (thread answer)",
  tip_stripe: "wallet ledger, Stripe dashboard",
  topup_stripe: "wallet ledger, Stripe dashboard events",
  ts_ban: "admin",
  ts_release: "admin",
  unknown_fact_deflect: "fan chat",
  unlock_wallet: "fan LockedCard, wallet ledger",
  user_flag: "admin",
  verify_admits_ai: "turn explorer verify trail",
  verify_retry: "turn explorer attempts, jev_out",
  warning_strikes: "fan chat (platform notice warning N of 3)",
};

export function renderCoverage(personas: readonly Persona[]): string {
  const rows = FEATURES.map((f) => {
    const who = personas.filter((p) => p.exercises.includes(f)).map((p) => `\`${p.slug}\``);
    return `| \`${f}\` | ${who.join(", ")} | ${SHOWN_IN[f]} |`;
  });
  return ["| engine feature | personas | visible in |", "|---|---|---|", ...rows].join("\n");
}

function fanSees(e: Expect | undefined, b: Beat): string {
  if (!e) return "";
  const route = Array.isArray(e.route) ? e.route.join(" or ") : e.route;
  if (e.silent) return "nothing";
  switch (route) {
    case "reply":
      return "a reply, up to 3 bubbles";
    case "offer":
      return "a reply and a LockedCard";
    case "hold_creator":
      return "a short in-voice filler";
    case "hard_stop":
      if ("row" in b && b.row === "minor") return "the platform notice (sender system); the history stays readable, the composer is off";
      if (b.kind !== "human" && "row" in b && b.row === "threat") return "one line in her voice, or nothing when no line passes its checks";
      return b.kind !== "human" && "sim" in b && b.sim?.notice ? "the platform notice that the chat is paused" : "the fixed template or platform notice";
    case "boundary":
      return "her boundary line, then the platform warning";
    case "deflect":
      return "an in-voice deflection";
    case "ai_disclosure":
      return "an honest answer in voice";
    default:
      return route ? String(route) : "";
  }
}

function expectCell(b: Beat): string {
  if (b.kind === "topup" || b.kind === "tip" || b.kind === "set_cap") return `${b.kind}: ${b.cents} cents${b.kind === "topup" ? " via PaymentIntent and webhook" : ""}`;
  if (b.kind === "unlock") return `unlock result \`${b.result}\``;
  if (b.kind === "nudge") return "offer expires_at moved into the past, then expireOffers()";
  if (b.kind === "human") return `as ${["release", "ban"].includes(b.action) ? "admin" : "Juno"}: \`${b.action}\``;
  if (b.kind === "wait") return `wait ${b.ms} ms`;
  const e = b.expect!;
  const parts: string[] = [];
  if (e.route) parts.push(`route ${Array.isArray(e.route) ? e.route.join("/") : e.route}`);
  if (e.queue !== "any") parts.push(`queue ${e.queue}`);
  if (e.offer) parts.push(`offer ${e.offer}`);
  if (e.alert !== undefined) parts.push(`alert ${e.alert}`);
  if (e.silent) parts.push("silent");
  if (e.admits_ai !== undefined) parts.push(`admits_ai ${e.admits_ai}`);
  if (e.turns !== undefined) parts.push(`turns ${e.turns}`);
  if (e.must_not?.length) parts.push(`must not match ${e.must_not.map((m) => `/${m}/`).join(" ")}`);
  if ("sim" in b && b.sim) for (const [k, v] of Object.entries(b.sim)) parts.push(`${k} ${JSON.stringify(v)}`);
  return parts.join("; ");
}

function junoSees(b: Beat): string {
  if (b.kind === "human") return b.action === "release" || b.action === "ban" ? "" : "her own console action";
  if (!("expect" in b) || !b.expect) return "";
  const out: string[] = [];
  if (b.expect.queue === "creator") out.push("a Handoff in her inbox");
  if (b.expect.alert) out.push("high_value_alert badge");
  return out.join("; ");
}

function tsSees(b: Beat): string {
  if (b.kind === "human") return b.action === "release" ? "releases the row" : b.action === "ban" ? "bans the fan" : "";
  if (!("expect" in b) || !b.expect) return "";
  return b.expect.queue === "ts" ? "a row in the T&S queue" : "";
}

function analyticsCell(b: Beat): string {
  if (b.kind === "topup") return "top-up revenue";
  if (b.kind === "tip") return "tips";
  if (b.kind === "unlock") return "offer funnel, revenue";
  if (!("row" in b) || !b.row) return "route mix";
  return `route mix, row ${b.row}`;
}

export function renderPersonas(personas: readonly Persona[]): string {
  return personas
    .map((p) => {
      const head = [
        `### \`${p.slug}\``,
        "",
        `${p.name}, voice: ${p.voice}. Goal: ${p.goal}. Spend: $${(p.spend_cents / 100).toFixed(2)}. Weight ${p.weight}${p.slug === "minor" ? " (drawn only with --include-minor)" : ""}. Language ${p.lang}. Free play: ${p.free_play ? "yes" : "no"}.`,
        `Variants: ${p.variants.map((v) => `${v.name}, ${v.age}, ${v.city}`).join("; ")}.`,
        `Exercises: ${p.exercises.map((e) => `\`${e}\``).join(", ")}.`,
        "",
        "Brief (the file the agent reads, verbatim):",
        "",
        "```text",
        p.briefText.trimEnd(),
        "```",
        "",
        "| # | beat | line or action | expected | fan sees | Juno sees | T&S sees | analytics | waits on |",
        "|---|---|---|---|---|---|---|---|---|",
      ];
      const rows = p.beats.map((b, i) => {
        const line = b.kind === "say" ? (b.fixed ? `fixed: "${b.text}"` : `${b.checkpoint}${b.example ? ` (e.g. "${b.example}")` : ""}`) : b.kind === "burst" ? `fixed burst: ${b.texts.map((t) => `"${t}"`).join(", ")}` : labelOf(b);
        const exp = "expect" in b ? b.expect : undefined;
        const pend = "pending" in b && b.pending ? `engine change ${b.pending.pr}: ${b.pending.note}` : "";
        return `| ${i + 1} | ${b.kind} | ${cell(line)} | ${cell(expectCell(b))} | ${cell(fanSees(exp, b))} | ${cell(junoSees(b))} | ${cell(tsSees(b))} | ${cell(analyticsCell(b))} | ${cell(pend)} |`;
      });
      return [...head, ...rows].join("\n");
    })
    .join("\n\n");
}

export function renderRegion(region: Region, personas: readonly Persona[]): string {
  return region === "coverage" ? renderCoverage(personas) : renderPersonas(personas);
}

const marker = (region: Region) => ({ open: `<!-- sim:${region} -->`, close: `<!-- /sim:${region} -->` });

/** Replaces each generated region of the doc in place. Returns the files written. */
export function writeDocSections(personas: readonly Persona[], file = FAN_SIM_DOC): string[] {
  let doc = readFileSync(file, "utf8");
  for (const r of REGIONS) {
    const { open, close } = marker(r);
    const a = doc.indexOf(open);
    const b = doc.indexOf(close);
    if (a < 0 || b < a) throw new Error(`${file}: missing ${open} … ${close}`);
    doc = `${doc.slice(0, a + open.length)}\n${renderRegion(r, personas)}\n${doc.slice(b)}`;
  }
  writeFileSync(file, doc);
  return [file];
}

/** The text currently between a region's markers. */
export function regionOf(doc: string, region: Region): string | null {
  const { open, close } = marker(region);
  const a = doc.indexOf(open);
  const b = doc.indexOf(close);
  return a < 0 || b < a ? null : doc.slice(a + open.length, b).trim();
}
