/** A 120x28 line of the values, no axes. Decorative: the number beside it carries the meaning. */
export function Spark({ values, label }: { values: number[]; label: string }) {
  const w = 120;
  const h = 28;
  const max = Math.max(...values, 0);
  const pts = values.map((v, i) => {
    const x = values.length > 1 ? (i / (values.length - 1)) * (w - 4) + 2 : w / 2;
    const y = max > 0 ? h - 3 - (v / max) * (h - 6) : h - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${w} ${h}`} width={w} height={h} className="mt-1 block">
      <title>{label}</title>
      <polyline points={pts.join(" ")} fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
