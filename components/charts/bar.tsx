export interface BarDatum {
  label: string;
  value: number;
  /** Formatted value; defaults to the integer. */
  text?: string;
}

/**
 * Horizontal bars, one accent hue, sorted as given. The visible numbers are the table; the bars are the shape.
 * A zero or empty series draws nothing but still reads as a table row.
 */
export function BarList({ title, data, unit }: { title: string; data: BarDatum[]; unit?: string }) {
  const max = Math.max(...data.map((d) => d.value), 0);
  return (
    <figure className="m-0">
      <figcaption className="mb-3 text-[15px] font-medium text-ink">{title}</figcaption>
      {data.length === 0 ? (
        <p className="text-[14px] text-muted">No data in this range.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {data.map((d) => (
            <li key={d.label} className="grid grid-cols-[minmax(84px,148px)_1fr_auto] items-center gap-3 text-[14px]">
              <span className="truncate text-ink-2" title={d.label}>{d.label}</span>
              <svg viewBox="0 0 100 10" preserveAspectRatio="none" className="h-2.5 w-full" role="img" aria-label={`${d.label}: ${d.text ?? d.value}${unit ? ` ${unit}` : ""}`}>
                <title>{`${d.label}: ${d.text ?? d.value}`}</title>
                <rect x="0" y="0" width="100" height="10" rx="2" fill="var(--color-surface)" />
                {max > 0 && d.value > 0 ? <rect x="0" y="0" width={Math.max(1.5, (d.value / max) * 100)} height="10" rx="2" fill="var(--color-accent)" /> : null}
              </svg>
              <span className="tabular-nums text-ink">{d.text ?? d.value}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

/** Vertical columns over time with a few labelled ticks, and the full series as a screen-reader table. */
export function Columns({ title, points, format = (n) => String(n) }: { title: string; points: { label: string; value: number }[]; format?: (n: number) => string }) {
  const w = 600;
  const h = 140;
  const pad = { l: 4, r: 4, t: 8, b: 20 };
  const max = Math.max(...points.map((p) => p.value), 0);
  const slot = (w - pad.l - pad.r) / Math.max(points.length, 1);
  const bw = Math.max(2, slot - 2);
  const tickEvery = Math.max(1, Math.ceil(points.length / 6));
  return (
    <figure className="m-0">
      <figcaption className="mb-2 text-[15px] font-medium text-ink">{title}</figcaption>
      <svg viewBox={`0 0 ${w} ${h}`} className="block h-auto w-full" role="img" aria-label={`${title}: peak ${format(max)}`}>
        <title>{title}</title>
        <line x1={pad.l} x2={w - pad.r} y1={h - pad.b} y2={h - pad.b} stroke="var(--color-line-2)" />
        {points.map((p, i) => {
          const bh = max > 0 ? (p.value / max) * (h - pad.t - pad.b) : 0;
          const x = pad.l + i * slot + (slot - bw) / 2;
          return (
            <g key={i}>
              <rect x={x} y={h - pad.b - bh} width={bw} height={bh} rx="2" fill="var(--color-accent)">
                <title>{`${p.label}: ${format(p.value)}`}</title>
              </rect>
              {i % tickEvery === 0 ? (
                <text x={x + bw / 2} y={h - 5} textAnchor="middle" fontSize="11" fill="var(--color-muted)">{p.label}</text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <table className="sr-only">
        <caption>{title}</caption>
        <tbody>
          {points.map((p, i) => (
            <tr key={i}><th scope="row">{p.label}</th><td>{format(p.value)}</td></tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
