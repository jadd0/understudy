import Link from "next/link";
import { BarList, Columns } from "@/components/charts/bar";
import { Funnel } from "@/components/charts/funnel";
import { LineChart } from "@/components/charts/line";
import { Spark } from "@/components/charts/spark";
import { Stat } from "@/components/charts/stat";
import { getDashboard } from "@/lib/analytics/dashboard";
import { handoffMean, readEvals, rubricMean } from "@/lib/analytics/evals";
import { DASH, count, ms, pct, seconds, usd, usdMicros } from "@/lib/analytics/format";
import { makeQuery } from "@/lib/analytics/query";
import { isSimFilter } from "@/lib/analytics/scope";
import { RANGES, isRangeKey, parseRange, type Bucket } from "@/lib/analytics/range";
import { PAGE_SIZE, ROUTE_FILTERS, listTurns } from "@/lib/analytics/turns";
import { requireAnalyticsViewer } from "@/lib/analytics/viewer";
import { listOpenUncredited } from "@/lib/wallet/uncredited";
import { resolveUncreditedAction } from "./actions";
import { TurnTable } from "./turn-table";

export const dynamic = "force-dynamic";

type Search = { range?: string; route?: string; outcome?: string; page?: string; sim?: string };

const label = (t: number, bucket: Bucket) => {
  const d = new Date(t);
  return bucket === "hour"
    ? `${String(d.getUTCHours()).padStart(2, "0")}:00`
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
};

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-t border-line pt-8">
      <div>
        <h2 className="m-0 text-[18px] font-semibold tracking-tight">{title}</h2>
        {hint ? <p className="m-0 mt-1 text-[14px] text-muted-2">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Table({ head, rows, empty }: { head: string[]; rows: React.ReactNode[][]; empty: string }) {
  if (rows.length === 0) return <p className="text-[14px] text-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[14px]">
        <thead>
          <tr>{head.map((h, i) => <th key={h} className={`border-b border-line py-2 pr-4 font-medium text-muted-2 ${i > 0 ? "text-right" : ""}`}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j} className={`border-b border-line py-2 pr-4 tabular-nums ${j > 0 ? "text-right" : ""}`}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<Search> }) {
  // The scope comes from the session. Nothing in the URL names a creator.
  const { scope, isAdmin } = await requireAnalyticsViewer();
  const sp = await searchParams;
  // Money only the platform sees: a paid Checkout that credited nobody, waiting for a refund in Stripe.
  const uncredited = isAdmin ? await listOpenUncredited() : [];
  const key = isRangeKey(sp.range) ? sp.range : "7d";
  const now = new Date();
  const range = parseRange(key, now);
  const sim = isSimFilter(sp.sim) ? sp.sim : "all";
  const q = makeQuery({ ...scope, sim }, range, now);
  const [d, evals, page] = await Promise.all([
    getDashboard(q),
    readEvals(),
    listTurns(q, { route: sp.route, outcome: sp.outcome, page: Number(sp.page) || 1 }),
  ]);
  const lbl = (t: number) => label(t, range.bucket);
  const pill = (active: boolean) =>
    `inline-flex min-h-11 items-center rounded-pill px-4 text-[14px] ${active ? "bg-ink text-ground" : "bg-surface text-ink-2 hover:bg-hover"}`;
  const notRun = "not run";
  const e = (v: number | undefined, f: (n: number) => string) => (v === undefined ? notRun : f(v));

  return (
    <main className="mx-auto flex w-full max-w-[1100px] flex-col gap-8 px-4 py-6 md:px-8 md:py-10">
      <header className="flex flex-col gap-4">
        <div>
          <h1 className="m-0 text-[26px] font-semibold tracking-tight">Analytics</h1>
          <p className="m-0 mt-1 text-[14px] text-muted-2">
            {isAdmin ? "All creators, read-only." : "Your conversations."} Last {key}, UTC. Trust &amp; Safety conversations are {isAdmin ? "included" : "not shown to creators"}.
          </p>
        </div>
        <nav aria-label="Range" className="flex flex-wrap gap-2">
          {RANGES.map((r) => (
            <Link key={r} href={`/analytics?range=${r}`} aria-current={r === key ? "page" : undefined} className={pill(r === key)}>{r}</Link>
          ))}
        </nav>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Fan messages" value={count(d.volume.totals.fanMessages)} sub={`${count(d.volume.totals.activeConversations)} conversations active`}>
          <Spark label="Fan messages over the range" values={d.volume.series.map((p) => p.fanMessages)} />
        </Stat>
        <Stat label="Revenue" value={usd(d.revenue.totalCents)} sub={`${usd(d.revenue.unlockCents)} unlocks, ${usd(d.revenue.tipCents)} tips`}>
          <Spark label="Revenue over the range" values={d.revenue.series.map((p) => p.unlockCents + p.tipCents)} />
        </Stat>
        <Stat label="Cost per reply" value={usdMicros(d.cost.perReplyMicros)} sub={`${usdMicros(d.cost.totalMicros)} total, ${count(d.cost.replies)} replies`} />
        <Stat label="Handoff rate" value={pct(d.handoffs.rate)} sub={`${count(d.handoffs.opened)} of ${count(d.handoffs.turns)} turns, ${count(d.handoffs.openNow)} open now`} />
      </div>

      <Section title="Volume" hint="Messages that reached the fan or came from the fan. Held drafts and superseded replies are not counted.">
        <Columns title="Fan messages per bucket" points={d.volume.series.map((p) => ({ label: lbl(p.t), value: p.fanMessages }))} />
        <Table
          head={["Message", "Count"]}
          empty="No messages in this range."
          rows={[["From fans", d.volume.totals.fanMessages], ["AI replies", d.volume.totals.aiReplies], ["Human replies", d.volume.totals.humanReplies], ["Conversations active", d.volume.totals.activeConversations]].map(([a, b]) => [a as string, count(b as number)])}
        />
      </Section>

      <Section title="Route mix" hint="What the engine decided on each turn, and how each turn ended.">
        <div className="grid gap-8 md:grid-cols-2">
          <BarList title="By route" data={d.routes.byRoute.map((r) => ({ label: r.route, value: r.count }))} />
          <BarList title="By outcome" data={d.routes.byOutcome.map((r) => ({ label: r.outcome, value: r.count }))} />
        </div>
      </Section>

      <Section title="Handoffs" hint={`Claim time p50 ${seconds(d.handoffs.claimSeconds.p50)}, p95 ${seconds(d.handoffs.claimSeconds.p95)}. Resolve time p50 ${seconds(d.handoffs.resolveSeconds.p50)}, p95 ${seconds(d.handoffs.resolveSeconds.p95)}.`}>
        <Table
          head={["Queue", "Reason", "Opened", "Claim p50", "Claim p95"]}
          empty="No handoffs in this range."
          rows={d.handoffs.groups.map((g) => [g.queue, g.reason, count(g.count), seconds(g.p50), seconds(g.p95)])}
        />
      </Section>

      <Section title="Offers" hint="An offer converts when the same fan unlocks the same item after it was made and before it expired, or pays for that offer again for an item he already owned.">
        <div className="grid gap-8 md:grid-cols-[2fr_1fr]">
          <Funnel
            title="Offer funnel"
            steps={[
              { label: "Made", value: d.offers.made },
              { label: "Unlocked", value: d.offers.unlocked },
              { label: "Declined", value: d.offers.declined },
              { label: "Expired", value: d.offers.expired },
              { label: "Still open", value: d.offers.stillOpen },
            ]}
          />
          <div className="flex flex-col gap-3">
            <Stat label="Acceptance rate" value={pct(d.offers.acceptanceRate)} sub="unlocked / made" />
            <Stat label="Offer rate" value={pct(d.offers.offerRate)} sub={`${count(d.offers.offerTurns)} offer turns of ${count(d.offers.replyTurns)} replies`} />
          </div>
        </div>
      </Section>

      <Section title="Revenue" hint="Unlocks and tips, in whole cents. Per-conversation figures cover conversations with any message in the range.">
        <LineChart title="Revenue per bucket" points={d.revenue.series.map((p) => ({ label: lbl(p.t), value: p.unlockCents + p.tipCents }))} format={usd} />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Per conversation, mean" value={usd(d.revenue.perConversation.meanCents)} />
          <Stat label="Per conversation, median" value={usd(d.revenue.perConversation.p50Cents)} />
          <Stat label="Paying conversations" value={count(d.revenue.perConversation.paying)} sub={`of ${count(d.revenue.perConversation.conversations)}`} />
          <Stat label="Total" value={usd(d.revenue.totalCents)} />
        </div>
        <h3 className="m-0 text-[15px] font-medium">Top high-value fans</h3>
        <Table
          head={["Fan", "Recent spend (decayed)", "Spent (all time)"]}
          empty="No spend yet."
          rows={d.topFans.map((f) => [`${f.fanId.slice(0, 8)}${f.isSim ? " (sim)" : ""}`, usd(f.scoreCents), usd(f.spentCents)])}
        />
      </Section>

      <Section title="Latency" hint="Milliseconds from the stored timings, percentiles computed in the database.">
        <Table
          head={["Stage", "p50", "p95", "Turns"]}
          empty=""
          rows={([["Jev in", "ms_jev_in"], ["Generate", "ms_gen"], ["Jev out", "ms_jev_out"], ["Total", "ms_total"]] as const).map(([name, k]) => [name, ms(d.latency[k].p50), ms(d.latency[k].p95), count(d.latency[k].samples)])}
        />
      </Section>

      <Section title="Cost" hint="Total spend divided by replies. A superseded draft's tokens count as spend, not as a reply.">
        <Columns title="Spend per bucket" points={d.cost.series.map((p) => ({ label: lbl(p.t), value: p.micros }))} format={usdMicros} />
        <Table
          head={["Stage", "Model", "Input tok", "Output tok", "Estimated"]}
          empty="No model calls in this range."
          rows={d.cost.byModel.map((m) => [m.stage, m.model, count(m.inputTokens), count(m.outputTokens), usdMicros(m.estimatedMicros)])}
        />
      </Section>

      <Section title="Responsible monetisation" hint="Hardship, spending cap and cooldown rules. Pitched despite hardship must stay at 0.">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Hardship turns" value={count(d.responsible.hardshipTurns)} sub="pitching blocked" />
          <Stat label="Pitched despite hardship" value={count(d.responsible.pitchedDespiteHardship)} tone={d.responsible.pitchedDespiteHardship > 0 ? "danger" : undefined} sub="must be 0" />
          <Stat label="Cooldowns active" value={count(d.responsible.hardshipCooldownsActive)} sub="conversations, now" />
          <Stat label="Fans at daily cap" value={count(d.responsible.fansAtCapToday)} sub="today, UTC" />
        </div>
      </Section>

      <Section title="Quality evals" hint="Read from docs/evals/engine.json and docs/evals/persona.json; each tile reads not run until its file exists.">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <Stat label="Safety violations" value={e(evals.engine?.safetyViolations, String)} sub="must be 0" />
          <Stat label="Handoff precision" value={e(handoffMean(evals.engine, "precision"), pct)} sub="mean of queues" />
          <Stat label="Handoff recall" value={e(handoffMean(evals.engine, "recall"), pct)} sub="mean of queues" />
          <Stat label="Route accuracy" value={e(evals.engine?.routeAccuracy, pct)} />
          <Stat label="Persona rubric" value={e(rubricMean(evals.persona), (n) => n.toFixed(2))} sub="mean, 1 to 5" />
          <Stat label="Blind test" value={e(evals.persona?.blindTest?.accuracy, pct)} sub="50% means indistinguishable" />
        </div>
      </Section>

      <Section title="Turn explorer" hint={`${count(page.total)} turns. Open one for its Jev answers, draft and timings.`}>
        <form method="get" action="/analytics" className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="range" value={key} />
          <label className="flex flex-col gap-1 text-[13px] text-muted-2">Route
            <select name="route" defaultValue={sp.route ?? ""} className="min-h-11 rounded-field bg-surface px-3 text-[15px] text-ink">
              <option value="">All</option>
              {ROUTE_FILTERS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[13px] text-muted-2">Outcome
            <select name="outcome" defaultValue={sp.outcome ?? ""} className="min-h-11 rounded-field bg-surface px-3 text-[15px] text-ink">
              <option value="">All</option>
              {["replied", "handoff", "hard_stop", "suggested", "superseded", "error"].map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
          <button type="submit" className="min-h-11 rounded-pill bg-ink px-5 text-[14px] text-ground hover:bg-ink-2">Filter</button>
        </form>
        <TurnTable
          key={`${key}|${sim}|${sp.route ?? ""}|${sp.outcome ?? ""}`}
          initial={page}
          filters={{ range: key, sim, route: sp.route, outcome: sp.outcome }}
          pageSize={PAGE_SIZE}
        />
      </Section>
      {isAdmin ? (
        <Section title="Payments needing review" hint="Paid Checkout events that credited no wallet. Refund each one in Stripe, then mark it resolved here.">
          <Table
            head={["When (UTC)", "Reason", "Fan", "Session", "Amount", ""]}
            rows={uncredited.map((u) => [
              u.createdAt.toISOString().slice(5, 16).replace("T", " "),
              u.reason,
              u.fanId ? u.fanId.slice(0, 8) : DASH,
              u.stripeSessionId ?? DASH,
              u.amountCents === null ? DASH : `${(u.amountCents / 100).toFixed(2)} ${(u.currency ?? "").toUpperCase()}`.trim(),
              <form key={u.id} action={resolveUncreditedAction}>
                <input type="hidden" name="id" value={u.id} />
                <button type="submit" className="rounded-full border border-line px-3 py-1 text-[13px] font-medium hover:bg-surface-2">
                  Mark resolved
                </button>
              </form>,
            ])}
            empty="Nothing needs review."
          />
        </Section>
      ) : null}
    </main>
  );
}
