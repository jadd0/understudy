/** Layout limits for the desktop sidebar. Layout, not business, so constants rather than config rows. */
export const SIDEBAR_DEFAULT = 320;
export const SIDEBAR_MIN = 260;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_STEP = 16;
export const SIDEBAR_STORAGE_KEY = "sidebar-width";

/** Clamp to the allowed range; anything that is not a finite number falls back to the default. */
export function clampSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(value)));
}

/** Reads the stored string: a missing or non-numeric value is the default, an out-of-range one is clamped. */
export function parseStoredSidebarWidth(raw: string | null | undefined): number {
  if (raw == null || !/^\s*-?\d+(\.\d+)?\s*$/.test(raw)) return SIDEBAR_DEFAULT;
  return clampSidebarWidth(Number(raw));
}

/** One arrow-key step in the given direction, clamped. */
export function stepSidebarWidth(width: number, direction: -1 | 1): number {
  return clampSidebarWidth(width + direction * SIDEBAR_STEP);
}
