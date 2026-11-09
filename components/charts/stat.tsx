import type { ReactNode } from "react";

/** One headline number. `value` is already formatted; a missing figure renders as a dash, never NaN. */
export function Stat({ label, value, sub, tone, children }: { label: string; value: string; sub?: string; tone?: "danger"; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-row border border-line bg-ground p-4">
      <span className="text-[13px] text-muted">{label}</span>
      <span className={`text-[26px] font-semibold leading-none tracking-tight ${tone === "danger" ? "text-danger" : "text-ink"}`}>{value}</span>
      {sub ? <span className="text-[13px] text-muted-2">{sub}</span> : null}
      {children}
    </div>
  );
}
