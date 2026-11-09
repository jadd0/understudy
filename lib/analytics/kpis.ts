import type { Dashboard } from "./dashboard";
import { handoffMean, rubricMean, type Evals } from "./evals";
import { count, ms, pct, seconds, usd, usdMicros } from "./format";

export interface Kpi {
  id: string;
  title: string;
  definition: string;
  formula: string;
  /** File and function the number comes from. */
  source: string;
  counts: string;
  excludes: string;
  read: string;
  /** Markdown for the latest values. */
  values: (d: Dashboard, evals: Evals) => string;
}

const table = (head: string[], rows: string[][]) =>
  rows.length === 0
    ? "_No data in this range._"
    : [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
const kv = (rows: [string, string][]) => table(["Measure", "Value"], rows);
const ev = (v: number | undefined, f: (n: number) => string) => (v === undefined ? "not run" : f(v));

export const KPIS: Kpi[] = [
  {
    id: "volume",
    title: "Volume",
    definition: "Messages exchanged in the range, split by who sent them, and how many conversations had any message.",
    formula: "fan = count(messages where sender = fan); AI replies = count(sender = ai and status = sent and not suggested); human replies = count(sender in creator, admin and status = sent); active conversations = count(distinct conversation_id).",
    source: "lib/analytics/volume.ts `getVolume`",
    counts: "Messages created inside the window in conversations the viewer may read.",
    excludes: "Superseded AI replies and held (suggested) drafts, which the fan never saw; messages from other creators; T&S conversations for a creator.",
    read: "Fan messages is demand; AI replies over fan messages shows how much the AI answers versus the creator or a handoff.",
    values: (d) =>
      kv([
        ["Fan messages", count(d.volume.totals.fanMessages)],
        ["AI replies", count(d.volume.totals.aiReplies)],
        ["Human replies", count(d.volume.totals.humanReplies)],
        ["Conversations active", count(d.volume.totals.activeConversations)],
      ]),
  },
  {
    id: "route-mix",
    title: "Route mix and turn outcomes",
    definition: "How many turns the engine ran, by the route it chose and by how the turn ended.",
    formula: "count(turns) grouped by route (null shown as none) and by outcome.",
    source: "lib/analytics/routes.ts `getRoutes`",
    counts: "Every turn row created in the window: replied, handoff, hard_stop, suggested, superseded, error.",
    excludes: "Hand-back stamps (outcome handback), which are bookkeeping rows and not turns the engine ran.",
    read: "A healthy mix is mostly reply with a steady share of offer. Many error or superseded turns point at provider failures or fans typing faster than the debounce.",
    values: (d) =>
      `${table(["Route", "Turns"], d.routes.byRoute.map((r) => [r.route, count(r.count)]))}\n\n${table(["Outcome", "Turns"], d.routes.byOutcome.map((r) => [r.outcome, count(r.count)]))}`,
  },
  {
    id: "handoff-rate",
    title: "Handoff rate",
    definition: "How often the AI hands a conversation to a human.",
    formula: "handoffs opened in the window / turns run in the window. Null (shown as a dash) with no turns.",
    source: "lib/analytics/handoffs.ts `getHandoffs` (rate)",
    counts: "Handoff rows whose opened_at is in the window, by queue and reason; one row per escalation, as a handoff escalates in place.",
    excludes: "Hand-back stamps in the denominator; T&S handoffs for a creator.",
    read: "Rising rate with the reason custom_request is demand for personal content; rising unsure or verify_failed means the AI is struggling.",
    values: (d) =>
      `${kv([["Opened", count(d.handoffs.opened)], ["Turns", count(d.handoffs.turns)], ["Rate", pct(d.handoffs.rate)], ["Open now", count(d.handoffs.openNow)]])}\n\n${table(["Queue", "Reason", "Opened"], d.handoffs.groups.map((g) => [g.queue, g.reason, count(g.count)]))}`,
  },
  {
    id: "handoff-times",
    title: "Time to claim and time to resolve",
    definition: "How long a handoff waits for a human, and how long until it is resolved.",
    formula: "p50 and p95 of (claimed_at - opened_at) and (resolved_at - opened_at) in seconds, percentile_cont in SQL.",
    source: "lib/analytics/handoffs.ts `getHandoffs` (claimSeconds, resolveSeconds, groups)",
    counts: "Handoffs opened in the window that have been claimed (or resolved).",
    excludes: "Handoffs not yet claimed or resolved; they have no time yet and appear in Open now.",
    read: "p95 claim time is the fan's worst-case wait for a person.",
    values: (d) =>
      `${kv([["Claim p50", seconds(d.handoffs.claimSeconds.p50)], ["Claim p95", seconds(d.handoffs.claimSeconds.p95)], ["Resolve p50", seconds(d.handoffs.resolveSeconds.p50)], ["Resolve p95", seconds(d.handoffs.resolveSeconds.p95)]])}\n\n${table(["Queue", "Reason", "Claim p50", "Claim p95"], d.handoffs.groups.map((g) => [g.queue, g.reason, seconds(g.p50), seconds(g.p95)]))}`,
  },
  {
    id: "offer-funnel",
    title: "Offer funnel and acceptance",
    definition: "Of the offers made, how many ended in an unlock, a decline or an expiry.",
    formula: "made = count(offers created in window); unlocked = made where an unlock exists for the same fan and item with unlock.created_at between offer.created_at and offer.expires_at, or an unlock ledger entry carries the offer id (a re-purchase of an item he already owned); declined = status declined and not unlocked; expired = status expired, or open past expires_at, and not unlocked; acceptance rate = unlocked / made.",
    source: "lib/analytics/offers.ts `getOfferFunnel`",
    counts: "Offers created in the window.",
    excludes: "An unlock by another fan, an unlock of the item before the offer existed, or one after it expired is never credited to the offer.",
    read: "Acceptance rate is conversion of pitches; a low rate with a high offer rate means pitches are too frequent or poorly timed.",
    values: (d) =>
      kv([
        ["Made", count(d.offers.made)],
        ["Unlocked", count(d.offers.unlocked)],
        ["Declined", count(d.offers.declined)],
        ["Expired", count(d.offers.expired)],
        ["Still open", count(d.offers.stillOpen)],
        ["Acceptance rate", pct(d.offers.acceptanceRate)],
      ]),
  },
  {
    id: "offer-rate",
    title: "Offer rate",
    definition: "How often a reply carries an offer.",
    formula: "turns with outcome replied and route offer / turns with outcome replied.",
    source: "lib/analytics/offers.ts `getOfferFunnel` (offerRate)",
    counts: "Committed reply turns in the window.",
    excludes: "Handoffs, hard stops, superseded and error turns.",
    read: "Pacing rules cap this; a rate near 0 means the AI is rarely allowed to pitch.",
    values: (d) => kv([["Offer turns", count(d.offers.offerTurns)], ["Reply turns", count(d.offers.replyTurns)], ["Offer rate", pct(d.offers.offerRate)]]),
  },
  {
    id: "revenue",
    title: "Revenue",
    definition: "Money fans spent with the creator on unlocks and tips.",
    formula: "sum(-amount_cents) over ledger_entries with amount_cents < 0 and kind unlock or tip, created in the window. Integer cents.",
    source: "lib/analytics/revenue.ts `getRevenue`",
    counts: "Debits to the creator, per day (or hour for 24h).",
    excludes: "Top-ups (a fan's own money moving into the wallet) and welcome-credit grants (platform money, not revenue); refunds are not netted out; T&S conversations for a creator.",
    read: "Unlocks versus tips shows whether income comes from the catalogue or from goodwill.",
    values: (d) => kv([["Unlocks", usd(d.revenue.unlockCents)], ["Tips", usd(d.revenue.tipCents)], ["Total", usd(d.revenue.totalCents)]]),
  },
  {
    id: "revenue-per-conversation",
    title: "Revenue per conversation",
    definition: "What an average conversation earned in the range.",
    formula: "For each conversation with any message in the window: sum of its unlock and tip debits in the window (0 when none). Mean = avg; median = percentile_cont(0.5).",
    source: "lib/analytics/revenue.ts `getRevenue` (perConversation)",
    counts: "Every active conversation, including those that spent nothing.",
    excludes: "Conversations with no message in the window, even if money moved.",
    read: "A median of 0 with a positive mean means a few fans pay and most do not.",
    values: (d) =>
      kv([
        ["Conversations", count(d.revenue.perConversation.conversations)],
        ["Paying", count(d.revenue.perConversation.paying)],
        ["Mean", usd(d.revenue.perConversation.meanCents)],
        ["Median", usd(d.revenue.perConversation.p50Cents)],
      ]),
  },
  {
    id: "top-fans",
    title: "Top high-value fans",
    definition: "Fans ranked by the high-value score: their spend in cents, each debit halved per half-life of age, so it reads in dollars and is at most the all-time spend.",
    formula: "score = round(sum(amount * 0.5^(age_days / half_life_days))) over the fan's debits to the creator, as of the report time; half-life from config fan.high_value_half_life_days.",
    source: "lib/analytics/revenue.ts `getTopFans`",
    counts: "All the fan's debits to the creator, not only the range.",
    excludes: "Credits (top-ups, refunds, welcome-credit grants). Simulated fans are included and tagged (sim).",
    read: "Recent spend weighs most; a fan above fan.high_value_threshold_cents triggers the high-value alert.",
    values: (d) =>
      table(["Fan", "Recent spend (decayed)", "Spent (all time)"], d.topFans.map((f) => [`${f.fanId.slice(0, 8)}${f.isSim ? " (sim)" : ""}`, usd(f.scoreCents), usd(f.spentCents)])),
  },
  {
    id: "latency",
    title: "Latency per stage",
    definition: "How long each stage of a turn takes.",
    formula: "p50 and p95 of ms_jev_in, ms_gen, ms_jev_out and ms_total via percentile_cont in SQL.",
    source: "lib/analytics/latency.ts `getLatency`",
    counts: "Turns in the window that recorded that stage.",
    excludes: "Turns where the stage did not run (no generation on a handoff, for example); null values are ignored, not counted as 0. ms_total is set only on turns that committed.",
    read: "p95 is the slow tail the fan feels. The debounce wait is not in these figures.",
    values: (d) =>
      table(
        ["Stage", "p50", "p95", "Turns"],
        (["ms_jev_in", "ms_gen", "ms_jev_out", "ms_total"] as const).map((k) => [k, ms(d.latency[k].p50), ms(d.latency[k].p95), count(d.latency[k].samples)]),
      ),
  },
  {
    id: "cost",
    title: "Cost per reply and by model",
    definition: "What the AI spends to produce a reply.",
    formula: "sum(turns.cost_micros) / count(turns with outcome replied). Whole micro-dollars, divided at render. By model: stored token counts re-priced at the current price.* config rows (an estimate).",
    source: "lib/analytics/cost.ts `getCost`",
    counts: "Every turn's cost, including superseded drafts and errors, in the numerator.",
    excludes: "Superseded, error, handoff and hard_stop turns from the denominator: only a committed reply is a reply.",
    read: "Superseded drafts raise the cost per reply, which is the price of the debounce race.",
    values: (d) =>
      `${kv([["Total spend", usdMicros(d.cost.totalMicros)], ["Replies", count(d.cost.replies)], ["Cost per reply", usdMicros(d.cost.perReplyMicros)]])}\n\n${table(["Stage", "Model", "Input tok", "Output tok", "Estimated"], d.cost.byModel.map((m) => [m.stage, m.model, count(m.inputTokens), count(m.outputTokens), usdMicros(m.estimatedMicros)]))}`,
  },
  {
    id: "responsible",
    title: "Responsible monetisation",
    definition: "Evidence that the responsible-selling rules hold: no pitch to a fan in hardship, spend caps, cooldowns.",
    formula: "hardship turns = committed turns where jev_in.parsed.p.hardship >= config floor.safety.hardship; pitched despite hardship = those with route offer (must be 0); cooldowns = conversations with no_pitch_until > report time; fans at cap = fans whose debits since 00:00 UTC >= their daily cap (own wallet cap, else wallet.daily_cap_cents).",
    source: "lib/analytics/responsible.ts `getResponsible`",
    counts: "Hardship turns in the window; cooldowns and caps as of the report time.",
    excludes: "The pacing reason for a withheld pitch (gap, declines, velocity): turns do not store it, so only hardship is split out from turn data.",
    read: "Pitched despite hardship is a defect count, not a rate; anything above 0 is a bug to open.",
    values: (d) =>
      kv([
        ["Hardship turns", count(d.responsible.hardshipTurns)],
        ["Pitched despite hardship", count(d.responsible.pitchedDespiteHardship)],
        ["Hardship cooldowns active", count(d.responsible.hardshipCooldownsActive)],
        ["Fans at daily cap today", count(d.responsible.fansAtCapToday)],
      ]),
  },
  {
    id: "evals",
    title: "Eval-backed quality",
    definition: "Handoff precision and recall, route accuracy and safety violations from the engine eval; persona rubric and blind-test accuracy from the persona eval. The report reads them and does not run them.",
    formula: "Read from docs/evals/engine.json and docs/evals/persona.json. Handoff precision and recall are the mean over the queues in the file; the persona score is the mean of the rubric criteria. A missing or unreadable file shows not run.",
    source: "lib/analytics/evals.ts `readEvals`",
    counts: "The latest run of each eval.",
    excludes: "Anything an eval has not written. Eval-run fans (email eval+...@understudy.test) are left out of every live KPI above, so eval traffic never skews them.",
    read: "Safety violations must be 0. A blind-test accuracy near 50% means the judge cannot tell the AI from the creator.",
    values: (_d, e) =>
      kv([
        ["Safety violations", ev(e.engine?.safetyViolations, String)],
        ["Handoff precision (mean of queues)", ev(handoffMean(e.engine, "precision"), pct)],
        ["Handoff recall (mean of queues)", ev(handoffMean(e.engine, "recall"), pct)],
        ["Route accuracy", ev(e.engine?.routeAccuracy, pct)],
        ["Persona rubric (mean)", ev(rubricMean(e.persona), (n) => n.toFixed(2))],
        ["Blind-test accuracy", ev(e.persona?.blindTest?.accuracy, pct)],
      ]),
  },
];
