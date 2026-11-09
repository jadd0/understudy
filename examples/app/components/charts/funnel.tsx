export interface FunnelStep {
  label: string;
  value: number;
  text?: string;
}

/** Steps as stacked bars scaled to the first step. Later steps are lighter ink, not new hues. */
export function Funnel({ title, steps }: { title: string; steps: FunnelStep[] }) {
  const top = steps[0]?.value ?? 0;
  return (
    <figure className="m-0">
      <figcaption className="mb-3 text-[15px] font-medium text-ink">{title}</figcaption>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {steps.map((s, i) => (
          <li key={s.label} className="grid grid-cols-[minmax(84px,148px)_1fr_auto] items-center gap-3 text-[14px]">
            <span className="text-ink-2">{s.label}</span>
            <svg viewBox="0 0 100 14" preserveAspectRatio="none" className="h-3.5 w-full" role="img" aria-label={`${s.label}: ${s.text ?? s.value}`}>
              <title>{`${s.label}: ${s.text ?? s.value}`}</title>
              <rect x="0" y="0" width="100" height="14" rx="2" fill="var(--color-surface)" />
              {top > 0 && s.value > 0 ? (
                <rect x="0" y="0" width={Math.max(1.5, (s.value / top) * 100)} height="14" rx="2" fill={i === 0 ? "var(--color-ink-2)" : "var(--color-accent)"} />
              ) : null}
            </svg>
            <span className="tabular-nums text-ink">{s.text ?? s.value}</span>
          </li>
        ))}
      </ol>
    </figure>
  );
}
