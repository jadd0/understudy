import type { ReactNode } from "react";

const TONES = {
  neutral: "bg-surface text-muted-2",
  accent: "bg-accent text-white",
  ink: "bg-ink text-ground",
} as const;

/** Small status chip: inbox rows and the console's header. `accent` is for what needs a person. */
export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: keyof typeof TONES }) {
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${TONES[tone]}`}>{children}</span>;
}

/** The tone each inbox badge gets: only what waits on a person is loud. */
export function badgeTone(label: string): keyof typeof TONES {
  return label === "Handoff" || label === "T&S" ? "accent" : label === "You" ? "ink" : "neutral";
}
