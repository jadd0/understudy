import Link from "next/link";
import { notFound } from "next/navigation";
import { DASH, ms, usd, usdMicros } from "@/lib/analytics/format";
import { getTurn } from "@/lib/analytics/turns";
import { requireAnalyticsViewer } from "@/lib/analytics/viewer";

export const dynamic = "force-dynamic";

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t border-line pt-6">
      <h2 className="m-0 text-[16px] font-semibold">{title}</h2>
      {children}
    </section>
  );
}
const Json = ({ value }: { value: unknown }) =>
  value == null ? <p className="text-[14px] text-muted">{DASH}</p> : (
    <pre className="m-0 overflow-x-auto rounded-field bg-surface p-3 text-[13px] leading-snug text-ink-2">{JSON.stringify(value, null, 2)}</pre>
  );

export default async function TurnPage({ params }: { params: Promise<{ id: string }> }) {
  const { scope } = await requireAnalyticsViewer();
  const { id } = await params;
  // Scope comes from the session; a turn outside it is a 404, the same as one that does not exist.
  const t = await getTurn(scope, id);
  if (!t) notFound();
  return (
    <main className="mx-auto flex w-full max-w-[860px] flex-col gap-6 px-4 py-6 md:px-8 md:py-10">
      <Link href="/analytics" className="inline-flex min-h-11 items-center text-[14px] text-accent underline">Back to analytics</Link>
      <header>
        <h1 className="m-0 text-[22px] font-semibold tracking-tight">Turn {t.id.slice(0, 8)}</h1>
        <p className="m-0 mt-1 text-[14px] text-muted-2">
          {t.createdAt.toISOString().replace("T", " ").slice(0, 19)} UTC, fan {t.fanId.slice(0, 8)}{t.isSim ? " (sim)" : ""}, route {t.route ?? DASH}, outcome {t.outcome ?? DASH}
        </p>
      </header>

      <Block title="Fan messages answered">
        {t.inbound.length === 0 ? <p className="text-[14px] text-muted">{DASH}</p> : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {t.inbound.map((m) => <li key={m.id} className="bubble bubble-them max-w-[80%]">{m.body}</li>)}
          </ul>
        )}
      </Block>

      <Block title="Reply and draft">
        {t.reply ? <p className="m-0 text-[15px]">{t.reply.body} <span className="text-muted">({t.reply.suggested ? "held draft" : t.reply.status})</span></p> : <p className="text-[14px] text-muted">No reply was stored for this turn.</p>}
        {t.draft && t.draft !== t.reply?.body ? <p className="m-0 text-[14px] text-muted-2">Last draft: {t.draft}</p> : null}
        <p className="m-0 text-[14px] text-muted-2">Attempts {t.attempts ?? DASH}, persona version {t.personaVersion ?? DASH}</p>
      </Block>

      <Block title="Timings and cost">
        <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-1 text-[14px] md:grid-cols-4">
          {([["Jev in", t.timings.msJevIn], ["Generate", t.timings.msGen], ["Jev out", t.timings.msJevOut], ["Total", t.timings.msTotal]] as const).map(([k, v]) => (
            <div key={k}><dt className="text-muted-2">{k}</dt><dd className="m-0 tabular-nums">{ms(v)}</dd></div>
          ))}
          <div><dt className="text-muted-2">Cost</dt><dd className="m-0 tabular-nums">{usdMicros(t.costMicros)}</dd></div>
        </dl>
        {t.offer ? <p className="m-0 text-[14px]">Offer {t.offer.id.slice(0, 8)}: {usd(t.offer.priceCents)}, {t.offer.status}</p> : null}
        {t.handoff ? <p className="m-0 text-[14px]">Handoff {t.handoff.queue} / {t.handoff.reason}, {t.handoff.status}</p> : null}
      </Block>

      <Block title="Jev in"><Json value={t.jevIn} /></Block>
      <Block title="Jev out"><Json value={t.jevOut} /></Block>
      <Block title="Models and tokens"><Json value={{ models: t.models, tokens: t.tokens }} /></Block>
    </main>
  );
}
