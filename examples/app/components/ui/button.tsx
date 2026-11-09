import type { ButtonHTMLAttributes, ReactNode } from "react";

/** 44px round icon button from the chat design. Icon-only, so a label is required. */
export function IconButton({
  label,
  children,
  tone = "plain",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode; tone?: "plain" | "accent" }) {
  const toneCls =
    tone === "accent"
      ? "h-10 w-10 bg-accent text-white hover:opacity-90"
      : "h-11 w-11 text-ink hover:bg-hover";
  return (
    <button
      type="button"
      aria-label={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-full ${toneCls} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Text buttons that sit with the design: primary is the ink pill (the design's selected tab), quiet is the accent "Send". */
export function Button({
  variant = "primary",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "quiet" }) {
  const v = {
    primary: "bg-ink text-ground hover:bg-ink-2",
    secondary: "border border-line-2 bg-ground text-ink hover:bg-hover",
    quiet: "text-accent hover:bg-hover",
  }[variant];
  return (
    <button
      className={`inline-flex h-11 items-center justify-center rounded-full px-5 text-[15px] font-semibold disabled:opacity-50 ${v} ${className}`}
      {...rest}
    />
  );
}
