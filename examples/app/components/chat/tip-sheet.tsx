"use client";

import { useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { FormAlert } from "@/components/ui/field";
import { dollarsToCents } from "@/lib/wallet/money";
import { tipLabel } from "@/lib/ui/tip-message";
import type { ActionResult } from "./types";

/**
 * The tip panel from the chat design: a popover above the composer on desktop, a bottom sheet with a scrim on a
 * phone. Preset amounts come from config; a custom amount (never below the minimum) sits where the design has its note.
 */
export function TipSheet({
  presets,
  minCents,
  onTip,
  walletHref,
  name,
  image = null,
  onClose,
  closing = false,
}: {
  presets: readonly number[];
  minCents: number;
  onTip: (key: string, cents: number) => Promise<ActionResult>;
  walletHref: string;
  name: string;
  image?: string | null;
  onClose: () => void;
  /** The out animation is playing; the composer unmounts the panel when it ends. */
  closing?: boolean;
}) {
  const [picked, setPicked] = useState<number | null>(presets[Math.floor(presets.length / 2)] ?? null);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typed = custom.trim() ? dollarsToCents(custom) : null;
  const cents = custom.trim() ? typed : picked;

  async function give() {
    if (cents === null || cents < minCents) {
      setError(`The smallest tip is ${tipLabel(minCents)}.`);
      return;
    }
    setBusy(true);
    setError(null);
    const res = await onTip(crypto.randomUUID(), cents);
    setBusy(false);
    if (res.ok) onClose();
    else setError(res.error);
  }

  return (
    <>
      <button
        type="button"
        aria-label="Close tip sheet"
        onClick={onClose}
        data-closing={closing ? "" : undefined}
        className="scrim-in fixed inset-0 z-[4] bg-scrim md:hidden"
      />
      <div
        id="tip-sheet"
        role="dialog"
        aria-label={`Send ${name} a tip`}
        data-closing={closing ? "" : undefined}
        className="tip-popup fixed inset-x-0 bottom-0 z-[5] flex flex-col gap-4 rounded-t-[28px] bg-raised px-5 pt-2.5 pb-8 shadow-sheet md:absolute md:inset-x-auto md:right-0 md:bottom-[calc(100%+10px)] md:w-[340px] md:gap-3.5 md:rounded-[26px] md:border md:border-line md:px-[18px] md:pt-4 md:pb-[18px] md:shadow-panel"
      >
        <span className="mx-auto h-[5px] w-10 rounded-[3px] bg-line md:hidden" aria-hidden="true" />
        <div className="flex items-center gap-2.5 md:justify-between">
          <span className="md:hidden">
            <Avatar name={name} src={image} size="tip" decorative />
          </span>
          <span className="flex-1 text-[16px] font-semibold md:flex-none md:text-[15px]">Tip {name}</span>
          <button
            type="button"
            aria-label="Close tip sheet"
            onClick={onClose}
            className="inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-hover md:h-9 md:w-9"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="md:h-[18px] md:w-[18px]">
              <path d="M18 6 6 18" />
              <path d="M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="text-center text-[64px] leading-none font-bold tracking-[-0.05em] tabular-nums md:text-[56px]">
          {cents !== null && cents > 0 ? tipLabel(cents) : "$0"}
        </div>
        <div className="flex gap-1.5">
          {presets.map((c) => {
            const on = !custom.trim() && picked === c;
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                disabled={busy}
                onClick={() => {
                  setPicked(c);
                  setCustom("");
                  // An error was about the old amount; a new one has not been tried yet.
                  setError(null);
                }}
                className={`h-11 min-w-0 flex-1 rounded-[22px] border text-[14px] font-medium transition-colors ${on ? "border-ink bg-ink text-ground" : "border-line hover:bg-hover"}`}
              >
                {tipLabel(c)}
              </button>
            );
          })}
        </div>
        <label htmlFor="tip-custom" className="sr-only">
          Custom amount
        </label>
        <input
          id="tip-custom"
          inputMode="decimal"
          autoComplete="off"
          value={custom}
          onChange={(e) => {
            setCustom(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void give();
            }
          }}
          placeholder="Custom amount"
          className="h-12 w-full rounded-[14px] border border-line bg-surface-2 px-3.5 text-[16px] outline-none placeholder:text-muted md:h-11 md:text-[14px]"
        />
        {error ? (
          <FormAlert>
            {error}
            {error.includes("wallet") ? (
              <>
                {" "}
                <a href={walletHref} className="font-semibold underline">
                  Open wallet
                </a>
              </>
            ) : null}
          </FormAlert>
        ) : null}
        <button
          type="button"
          disabled={busy || cents === null || cents <= 0}
          onClick={() => void give()}
          className="h-[54px] rounded-[27px] bg-tip text-[16px] font-bold text-tip-ink disabled:opacity-50 md:h-[50px] md:rounded-[25px] md:text-[15px]"
        >
          {cents !== null && cents > 0 ? `Send ${tipLabel(cents)} tip` : "Send tip"}
        </button>
      </div>
    </>
  );
}
