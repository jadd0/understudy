import type { ReactNode } from "react";
import type { ChatRow } from "@/lib/ui/group-messages";
import { Avatar } from "../avatar";
import { IconTip } from "../icons";

/** Renders grouped rows (lib/ui/group-messages) exactly as the chat design lays them out. */
export function MessageList({
  rows,
  otherName,
  otherImage = null,
  status,
  typing = false,
  freshKeys,
  renderExtra,
  tipSide = "me",
}: {
  rows: readonly ChatRow[];
  otherName: string;
  otherImage?: string | null;
  status?: string | null;
  typing?: boolean;
  /** Keys of rows that arrived after the page loaded; they animate in. */
  freshKeys?: ReadonlySet<string>;
  /** Extra content under a message bubble (e.g. a locked offer card), keyed by message id. */
  renderExtra?: (key: string) => ReactNode;
  /** Which side a tip card sits on: the fan sent it, so "me" in the fan's own view and "them" in a staff view. */
  tipSide?: "me" | "them";
}) {
  return (
    <div className="flex flex-col">
      {rows.map((r) => {
        if (r.kind === "separator") {
          return (
            <div key={r.key} className="mt-5 mb-3 self-center text-[12px] font-medium text-muted md:mt-[22px]">
              {r.label}
            </div>
          );
        }
        const fresh = freshKeys?.has(r.key) ?? false;
        if (r.tip) {
          const mine = tipSide === "me";
          return (
            <div key={r.key} className={`group mt-0.5 mb-3 flex items-end gap-2 ${mine ? "justify-end" : ""}`}>
              {/* Kept in the avatar column, so the card lines up with the fan's bubbles in a staff view. */}
              {mine ? <Time value={r.time} /> : <span className="w-7 shrink-0" />}
              <div className={`flex max-w-[76%] flex-col md:max-w-[min(66%,480px)] ${mine ? "items-end" : "items-start"}`}>
                <TipCard amount={r.tip} fresh={fresh} />
              </div>
              {mine ? null : <Time value={r.time} />}
            </div>
          );
        }
        if (r.side === "system") {
          return (
            <p key={r.key} role="note" className="mx-auto my-2.5 max-w-[420px] text-center text-[13px] leading-snug text-muted-2">
              {r.text}
            </p>
          );
        }
        const me = r.side === "me";
        return (
          <div key={r.key} className={`group mt-0.5 flex items-end gap-2 ${me ? "justify-end" : ""} ${r.last ? "mb-3" : ""}`}>
            {!me ? r.showAvatar ? <Avatar name={otherName} src={otherImage} size="xs" decorative /> : <span className="w-7 shrink-0" /> : null}
            {me ? <Time value={r.time} /> : null}
            <div className={`flex max-w-[76%] flex-col md:max-w-[min(66%,480px)] ${me ? "items-end" : "items-start"}`}>
              {/* Support writes as the platform, not as the creator, so its run is named. */}
              {r.support && r.first ? (
                <span className="mb-1 ml-1 text-[12px] font-medium text-muted-2">Understudy support</span>
              ) : null}
              <div
                className={`bubble transition-opacity duration-[450ms] group-hover:opacity-[.82] ${me ? "bubble-me" : "bubble-them"} ${fresh ? "bubble-new" : ""}`}
                data-first={r.first || undefined}
                data-last={r.last || undefined}
              >
                {r.text}
              </div>
              {renderExtra?.(r.key)}
            </div>
            {!me ? <Time value={r.time} /> : null}
          </div>
        );
      })}
      {status ? <span className="-mt-1.5 mr-1.5 mb-2 self-end text-[12px] text-muted">{status}</span> : null}
      {typing ? <TypingRow name={otherName} image={otherImage} /> : null}
    </div>
  );
}

/** The clock time beside a bubble, shown on hover. Desktop only: the phone artboard has none. */
function Time({ value }: { value: string }) {
  return (
    <span
      className="hidden self-center text-[11px] whitespace-nowrap text-muted tabular-nums opacity-0 transition-opacity duration-[450ms] group-hover:opacity-100 md:block"
      aria-hidden="true"
    >
      {value}
    </span>
  );
}

/** The yellow card the design draws for a tip the fan sent. */
function TipCard({ amount, fresh }: { amount: string; fresh: boolean }) {
  return (
    <div
      className={`relative flex min-w-[200px] flex-col gap-0.5 overflow-hidden rounded-[22px] bg-tip px-[18px] pt-3.5 pb-4 text-tip-ink transition-opacity duration-[450ms] group-hover:opacity-[.82] md:min-w-[210px] ${fresh ? "tip-card-new" : ""}`}
    >
      <span className="flex items-center gap-1.5 text-[12px] font-semibold tracking-[.04em] uppercase">
        <IconTip width={14} height={14} />
        Tip sent
      </span>
      <span className="text-[40px] leading-[1.05] font-bold tracking-[-0.04em] tabular-nums">{amount}</span>
      <span className="tip-shine" aria-hidden="true" />
    </div>
  );
}

export function TypingRow({ name, image = null }: { name: string; image?: string | null }) {
  return (
    <div className="typing-row-new mb-3 flex items-end gap-2" aria-live="polite">
      <Avatar name={name} src={image} size="xs" decorative />
      <div
        className="inline-flex h-[38px] items-center gap-1 rounded-[20px] bg-surface px-4"
        role="status"
        aria-label={`${name} is typing`}
      >
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </div>
    </div>
  );
}
