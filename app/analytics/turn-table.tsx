"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { DASH, ms, usdMicros } from "@/lib/analytics/format";
import type { TurnPage } from "@/lib/analytics/turns";
import { turnsPageAction, type TurnsPageInput } from "./actions";

const HEAD = ["When (UTC)", "Fan", "Route", "Outcome", "Total", "Cost"];
const cell = "border-b border-line py-2 pr-4";
const pill = "inline-flex min-h-11 items-center rounded-pill bg-surface px-4 text-[14px] text-ink-2 hover:bg-hover disabled:opacity-50 disabled:hover:bg-surface";

/**
 * The turn explorer's table and pager. A page change fetches only that page's rows through a server action and
 * keeps the URL in step with replaceState, so the charts above, the range and the scroll position stay put.
 * Short pages are padded with blank rows to `pageSize` so the table height does not jump between pages.
 */
export function TurnTable({ initial, filters, pageSize }: { initial: TurnPage; filters: Omit<TurnsPageInput, "page">; pageSize: number }) {
  const [page, setPage] = useState(initial);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();

  const go = (to: number) =>
    startTransition(async () => {
      const next = await turnsPageAction({ ...filters, page: to }).catch(() => null);
      if (!next) {
        setFailed(true);
        return;
      }
      setFailed(false);
      setPage(next);
      const url = new URL(window.location.href);
      if (next.page > 1) url.searchParams.set("page", String(next.page));
      else url.searchParams.delete("page");
      window.history.replaceState(window.history.state, "", url);
    });

  if (page.rows.length === 0) return <p className="text-[14px] text-muted">No turns match.</p>;
  const blanks = page.pages > 1 ? Math.max(0, pageSize - page.rows.length) : 0;

  return (
    <>
      <div className="overflow-x-auto">
        <table aria-busy={pending} className={`w-full border-collapse text-left text-[14px] transition-opacity ${pending ? "opacity-50" : ""}`}>
          <thead>
            <tr>{HEAD.map((h) => <th key={h} className={`${cell} font-medium text-muted-2`}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {page.rows.map((r) => (
              <tr key={r.id}>
                <td className={`${cell} tabular-nums`}>
                  <Link href={`/analytics/turns/${r.id}`} className="inline-flex min-h-11 items-center text-accent underline">{new Date(r.createdAt).toISOString().slice(5, 16).replace("T", " ")}</Link>
                </td>
                <td className={cell}>{r.fanId.slice(0, 8)}{r.isSim ? " (sim)" : ""}</td>
                <td className={cell}>{r.route ?? DASH}</td>
                <td className={cell}>{r.outcome ?? DASH}</td>
                <td className={`${cell} tabular-nums`}>{ms(r.msTotal)}</td>
                <td className={`${cell} tabular-nums`}>{usdMicros(r.costMicros)}</td>
              </tr>
            ))}
            {Array.from({ length: blanks }, (_, i) => (
              <tr key={`blank-${i}`} aria-hidden="true">
                <td colSpan={HEAD.length} className="border-b border-transparent py-2"><span className="inline-flex min-h-11" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-3 text-[14px]">
        <button type="button" onClick={() => go(page.page - 1)} disabled={pending || page.page <= 1} className={pill}>Previous</button>
        <span className="text-muted-2 tabular-nums">Page {page.page} of {page.pages}</span>
        <button type="button" onClick={() => go(page.page + 1)} disabled={pending || page.page >= page.pages} className={pill}>Next</button>
        <span className="text-muted" aria-live="polite">{pending ? "Loading…" : failed ? "Could not load that page." : ""}</span>
      </div>
    </>
  );
}
