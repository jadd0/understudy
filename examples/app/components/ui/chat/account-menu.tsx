"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { signOutAction } from "@/app/signout/actions";
import { Avatar } from "@/components/ui/avatar";
import { IconChevronsUpDown, IconMoon, IconSignOut } from "@/components/ui/icons";
import { THEME_STORAGE_KEY } from "@/lib/ui/theme";

function subscribeTheme(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => mo.disconnect();
}
const isDark = () => document.documentElement.classList.contains("dark");

function setDark(on: boolean) {
  document.documentElement.classList.toggle("dark", on);
  try {
    if (on) localStorage.setItem(THEME_STORAGE_KEY, "dark");
    else localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // Storage blocked: the theme still applies for this page view.
  }
}

const CLOSE_MS = 160;

/** The sidebar's bottom block: who is signed in, and a menu with the dark-mode switch and Sign out. */
export function AccountMenu({ name, roleLabel, image = null }: { name: string; roleLabel: string; image?: string | null }) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const trigger = useRef<HTMLButtonElement>(null);
  const dark = useSyncExternalStore(subscribeTheme, isDark, () => false);

  useEffect(() => () => clearTimeout(timer.current), []);

  function close(returnFocus = false) {
    if (!open || closing) return;
    setClosing(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, CLOSE_MS);
    if (returnFocus) trigger.current?.focus();
  }
  function toggle() {
    if (open && !closing) return close();
    clearTimeout(timer.current);
    setClosing(false);
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // close() reads the latest open/closing; re-subscribing on those is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, closing]);

  const active = open && !closing;
  return (
    <div className="relative border-t border-line p-2">
      {open ? (
        <>
          <button
            type="button"
            aria-label="Close account menu"
            tabIndex={-1}
            onClick={() => close()}
            className="fixed inset-0 z-[6] cursor-default"
          />
          <div
            role="menu"
            aria-label="Account"
            data-closing={closing ? "" : undefined}
            className="account-menu absolute right-2 bottom-[calc(100%+6px)] left-2 z-[7] flex flex-col rounded-[18px] border border-line bg-raised p-1.5 shadow-panel"
          >
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={dark}
              onClick={() => setDark(!dark)}
              className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[14px] font-medium transition-colors hover:bg-hover"
            >
              <IconMoon width={18} height={18} />
              <span className="flex-1">Dark mode</span>
              <span className="switch" data-on={dark ? "" : undefined} aria-hidden="true" />
            </button>
            <div className="mx-1.5 my-1 h-px bg-line" />
            <form action={signOutAction}>
              <button
                type="submit"
                role="menuitem"
                className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[14px] font-medium text-danger transition-colors hover:bg-hover"
              >
                <IconSignOut width={18} height={18} />
                Sign out
              </button>
            </form>
          </div>
        </>
      ) : null}
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={active}
        onClick={toggle}
        className={`flex w-full items-center gap-3 rounded-[14px] px-3 py-2 text-left transition-colors ${active ? "bg-surface" : "hover:bg-hover"}`}
      >
        <Avatar name={name} src={image} size="account" decorative />
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="truncate text-[14px] font-semibold">{name}</span>
          <span className="text-[12px] text-muted">{roleLabel}</span>
        </span>
        <IconChevronsUpDown className="shrink-0 text-muted" />
      </button>
    </div>
  );
}
