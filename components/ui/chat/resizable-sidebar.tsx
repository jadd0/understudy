"use client";

import { useRef, useSyncExternalStore, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  SIDEBAR_STORAGE_KEY,
  clampSidebarWidth,
  parseStoredSidebarWidth,
  stepSidebarWidth,
} from "@/lib/ui/sidebar-width";

/*
 * The width lives in a CSS variable on <html> (set before paint from storage, see lib/ui/theme.ts), so the first
 * paint is already at the stored width. This module store only mirrors it for the separator's aria values.
 */
let current: number | null = null;
const listeners = new Set<() => void>();

function readStored(): number {
  try {
    return parseStoredSidebarWidth(localStorage.getItem(SIDEBAR_STORAGE_KEY));
  } catch {
    return SIDEBAR_DEFAULT;
  }
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): number {
  current ??= readStored();
  return current;
}
function apply(width: number) {
  current = width;
  document.documentElement.style.setProperty("--sidebar-w", `${width}px`);
  listeners.forEach((l) => l());
}
function persist(width: number) {
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(width));
  } catch {
    // Private mode or blocked storage: the width still applies for this page view.
  }
}
function setWidth(width: number, save: boolean) {
  const w = clampSidebarWidth(width);
  apply(w);
  if (save) persist(w);
}

/** The desktop sidebar shell: a drag handle on the right edge, a real separator (keys, double-click, Home). */
export function ResizableSidebar({ className, children }: { className: string; children: ReactNode }) {
  const width = useSyncExternalStore(subscribe, getSnapshot, () => SIDEBAR_DEFAULT);
  const ref = useRef<HTMLElement>(null);
  const dragging = useRef(false);

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!dragging.current || !ref.current) return;
    setWidth(e.clientX - ref.current.getBoundingClientRect().left, false);
  }
  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    dragging.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    persist(getSnapshot());
  }
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      setWidth(stepSidebarWidth(getSnapshot(), e.key === "ArrowRight" ? 1 : -1), true);
    } else if (e.key === "Home") {
      e.preventDefault();
      setWidth(SIDEBAR_DEFAULT, true);
    }
  }

  return (
    <aside ref={ref} className={`relative ${className}`}>
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={width}
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        onDoubleClick={() => setWidth(SIDEBAR_DEFAULT, true)}
        className="group absolute inset-y-0 -right-[3px] z-[3] hidden w-1.5 cursor-col-resize touch-none outline-none md:block"
      >
        <span className="absolute inset-y-0 left-[2px] w-0.5 bg-accent opacity-0 transition-opacity group-hover:opacity-60 group-focus-visible:opacity-100 group-active:opacity-100" />
      </div>
    </aside>
  );
}
