"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { IconTip } from "../icons";

const DESKTOP = "(min-width: 768px)";
function subscribeDesktop(cb: () => void) {
  const mq = window.matchMedia(DESKTOP);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/**
 * The pill composer from the chat design: the input, a yellow "Tip" button while there is no draft, and
 * a filled "Send" once there is one. The tip panel opens above the pill (a popover on desktop, a sheet on a phone).
 */
export function Composer({
  label,
  onSend,
  disabled = false,
  placeholder = "Message…",
  desktopPlaceholder,
  tipPanel,
  onTyping,
  typingIntervalMs = 2000,
}: {
  label: string;
  onSend: (text: string) => void | Promise<void>;
  disabled?: boolean;
  placeholder?: string;
  /** The wider screen names the person ("Message Juno…"); the phone keeps the short form. */
  desktopPlaceholder?: string;
  /** Renders the tip panel while it is open; omitted when the viewer may not tip. */
  tipPanel?: (close: () => void, closing: boolean) => ReactNode;
  /** Called while keys are pressed, at most once per `typingIntervalMs`. */
  onTyping?: () => void;
  typingIntervalMs?: number;
}) {
  const lastPing = useRef(0);
  const [draft, setDraft] = useState("");
  const [tipOpen, setTipOpen] = useState(false);
  const [tipClosing, setTipClosing] = useState(false);
  const desktop = useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP).matches,
    () => false,
  );
  const hasDraft = draft.trim().length > 0;

  // The panel stays mounted while its out animation plays (200ms popover, 220ms sheet), then unmounts.
  // Re-opening during that window flips `tipClosing` back, which cancels the pending unmount.
  useEffect(() => {
    if (!tipClosing) return;
    const t = setTimeout(
      () => {
        setTipOpen(false);
        setTipClosing(false);
      },
      desktop ? 200 : 220,
    );
    return () => clearTimeout(t);
  }, [tipClosing, desktop]);
  const openTip = () => {
    setTipClosing(false);
    setTipOpen(true);
  };
  const closeTip = () => setTipClosing(true);

  useEffect(() => {
    if (!tipOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeTip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tipOpen]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || disabled) return;
    setDraft("");
    await onSend(text);
  }

  return (
    <form onSubmit={submit} className="px-3 pt-2 pb-7 md:px-6 md:pt-2.5 md:pb-[22px]">
      <div className="relative mx-auto max-w-[760px]">
        {tipOpen && tipPanel ? tipPanel(closeTip, tipClosing) : null}
        <div className="flex min-h-[52px] items-center gap-0.5 rounded-pill border border-line bg-ground p-1 transition-colors focus-within:border-muted md:min-h-[54px] md:gap-1 md:p-[5px]">
          <label htmlFor="composer" className="sr-only">
            {label}
          </label>
          <input
            id="composer"
            type="text"
            autoComplete="off"
            placeholder={desktop && desktopPlaceholder ? desktopPlaceholder : placeholder}
            value={draft}
            disabled={disabled}
            onChange={(e) => {
              setDraft(e.target.value);
              const now = Date.now();
              if (onTyping && e.target.value && now - lastPing.current >= typingIntervalMs) {
                lastPing.current = now;
                onTyping();
              }
            }}
            className="h-[42px] min-w-0 flex-1 border-0 bg-transparent pr-1.5 pl-3.5 text-[16px] outline-none placeholder:text-muted md:pr-2 md:pl-4 md:text-[15px]"
          />
          {hasDraft ? (
            <button
              type="submit"
              className="h-11 shrink-0 rounded-[22px] bg-accent px-[18px] font-semibold text-white hover:opacity-90"
            >
              Send
            </button>
          ) : tipPanel ? (
            <button
              type="button"
              aria-expanded={tipOpen && !tipClosing}
              aria-controls="tip-sheet"
              onClick={() => (tipOpen && !tipClosing ? closeTip() : openTip())}
              className={`${tipOpen && !tipClosing ? "tip-btn-on " : ""}inline-flex h-11 shrink-0 items-center gap-1.5 rounded-[22px] bg-tip pr-3.5 pl-2.5 text-[14px] font-semibold text-tip-ink transition-transform hover:-translate-y-px md:pr-4 md:pl-3`}
            >
              <IconTip />
              Tip
            </button>
          ) : null}
        </div>
      </div>
    </form>
  );
}
