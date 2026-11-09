import type { CSSProperties, ReactNode } from "react";

/*
 * Loading placeholders for streamed sections. Each piece is sized from the component it stands in for, so
 * the content replaces it without moving anything. They pulse gently; under prefers-reduced-motion they stay still.
 * Every block carries `data-skeleton` (counted by the screenshot check) and is hidden from assistive tech; one
 * `SkeletonStatus` per section announces "Loading" instead.
 */

const PULSE = "animate-pulse motion-reduce:animate-none";

type Tone = "surface" | "strong";
/** `surface` sits on the ground; `strong` sits on a surface-filled card, where surface would vanish. */
const TONE: Record<Tone, string> = { surface: "bg-surface", strong: "bg-line-2" };

/** A plain block. Size and radius come from the caller (`h-11 rounded-full`, `rounded-bubble`, …). */
export function Skeleton({ className = "", style, tone = "surface" }: { className?: string; style?: CSSProperties; tone?: Tone }) {
  return <span aria-hidden="true" data-skeleton="" className={`block shrink-0 ${TONE[tone]} ${PULSE} ${className}`} style={style} />;
}

/**
 * One line of text: a bar `bar` px tall, centred in a box the height of the real line (`lineHeight`), so the
 * line occupies exactly the space the text will.
 */
export function SkeletonLine({
  width = "100%",
  lineHeight = 22,
  bar = 10,
  tone,
  className = "",
}: {
  width?: number | string;
  lineHeight?: number;
  bar?: number;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span aria-hidden="true" className={`flex items-center ${className}`} style={{ height: lineHeight, width }}>
      <Skeleton tone={tone} className="w-full rounded-full" style={{ height: bar }} />
    </span>
  );
}

/** A round avatar placeholder at one of `Avatar`'s pixel sizes. */
export function SkeletonAvatar({ size = 48, className }: { size?: number; className?: string }) {
  const dot = <Skeleton className="rounded-full" style={{ width: size, height: size }} />;
  // `className` (e.g. `hidden md:block`) goes on a wrapper, so it never fights the block's own `display`.
  return className ? <span className={`shrink-0 ${className}`}>{dot}</span> : dot;
}

/** Name line widths for a list of rows, varied so a list does not read as a grid of identical bars. */
const NAME_W = ["46%", "58%", "38%", "52%", "64%", "42%"];
const PREVIEW_W = ["78%", "64%", "86%", "70%", "58%", "82%"];

/** A `ThreadList` row: 48px avatar, name line (15px) and preview line (13px), 68px tall like the real row. */
export function SkeletonRow({ index = 0 }: { index?: number }) {
  return (
    <span className="flex w-full items-center gap-3 rounded-[14px] px-3 py-2.5">
      <SkeletonAvatar size={48} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <SkeletonLine width={NAME_W[index % NAME_W.length]} lineHeight={22.5} bar={11} />
        <SkeletonLine width={PREVIEW_W[index % PREVIEW_W.length]} lineHeight={19.5} bar={9} />
      </span>
    </span>
  );
}

/** `count` thread rows. */
export function SkeletonRows({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonRow key={i} index={i} />
      ))}
    </>
  );
}

/** A one-line chat bubble (9px padding, 15px × 1.42 text = 39px), on the sender's side. */
export function SkeletonBubble({ side, width }: { side: "me" | "them"; width: number }) {
  return (
    <span className={`mt-0.5 flex items-end gap-2 ${side === "me" ? "justify-end" : ""}`}>
      {side === "them" ? <SkeletonAvatar size={28} /> : null}
      <Skeleton className="h-[39px] max-w-[76%] rounded-bubble md:max-w-[min(66%,480px)]" style={{ width }} />
    </span>
  );
}

/** A labelled `Field`: 13px label, 44px input, optional 12px hint, with the field's 6px gaps. */
export function SkeletonField({ labelWidth = 120, hint = true }: { labelWidth?: number; hint?: boolean }) {
  return (
    <span className="flex flex-col gap-1.5">
      <SkeletonLine width={labelWidth} lineHeight={19.5} bar={9} />
      <Skeleton className="h-11 w-full rounded-field" />
      {hint ? <SkeletonLine width="60%" lineHeight={18} bar={8} /> : null}
    </span>
  );
}

/** The one announcement per loading section: screen readers hear "Loading …" instead of a run of empty blocks. */
export function SkeletonStatus({ label = "Loading" }: { label?: string }) {
  return (
    <span role="status" className="sr-only">
      {label}
    </span>
  );
}

/** A wrapper for a section's skeleton: marks it busy and announces it once. */
export function SkeletonGroup({ label, className = "", children }: { label: string; className?: string; children?: ReactNode }) {
  return (
    <div aria-busy="true" className={className}>
      <SkeletonStatus label={label} />
      {children}
    </div>
  );
}
