/** One line over time with a filled-dot last point and a screen-reader table. One series, so no legend. */
export function LineChart({ title, points, format = (n) => String(n) }: { title: string; points: { label: string; value: number }[]; format?: (n: number) => string }) {
  const w = 600;
  const h = 140;
  const pad = { l: 6, r: 8, t: 10, b: 20 };
  const max = Math.max(...points.map((p) => p.value), 0);
  const xs = (i: number) => (points.length > 1 ? pad.l + (i / (points.length - 1)) * (w - pad.l - pad.r) : w / 2);
  const ys = (v: number) => (max > 0 ? h - pad.b - (v / max) * (h - pad.t - pad.b) : h - pad.b);
  const tickEvery = Math.max(1, Math.ceil(points.length / 6));
  const last = points.length - 1;
  return (
    <figure className="m-0">
      <figcaption className="mb-2 text-[15px] font-medium text-ink">{title}</figcaption>
      <svg viewBox={`0 0 ${w} ${h}`} className="block h-auto w-full" role="img" aria-label={`${title}: peak ${format(max)}`}>
        <title>{title}</title>
        <line x1={pad.l} x2={w - pad.r} y1={h - pad.b} y2={h - pad.b} stroke="var(--color-line-2)" />
        {points.length > 0 ? (
          <polyline fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" points={points.map((p, i) => `${xs(i).toFixed(1)},${ys(p.value).toFixed(1)}`).join(" ")} />
        ) : null}
        {points.map((p, i) => (
          <g key={i}>
            {i === last ? <circle cx={xs(i)} cy={ys(p.value)} r="4" fill="var(--color-accent)" stroke="var(--color-ground)" strokeWidth="2" /> : null}
            <circle cx={xs(i)} cy={ys(p.value)} r="9" fill="transparent"><title>{`${p.label}: ${format(p.value)}`}</title></circle>
            {i % tickEvery === 0 ? <text x={xs(i)} y={h - 5} textAnchor="middle" fontSize="11" fill="var(--color-muted)">{p.label}</text> : null}
          </g>
        ))}
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
