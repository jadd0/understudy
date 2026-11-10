import { IconLock } from "../icons";

/**
 * A paid message attached under one of the creator's bubbles. The design has no paid card, so this one
 * is built only from its tokens: bubble radius, surface fill, ink pill button, accent-free so the
 * price never competes with the fan's own blue bubbles.
 */
export function LockedCard({
  title,
  teaser,
  price,
  state = "locked",
  action,
}: {
  title: string;
  teaser: string;
  price: string;
  state?: "locked" | "unlocked" | "expired";
  action?: React.ReactNode;
}) {
  return (
    <div className="mt-1 w-[260px] max-w-full overflow-hidden rounded-[20px] border border-line bg-ground">
      <div
        className="relative flex h-[150px] items-center justify-center bg-surface"
        aria-hidden="true"
        style={{
          background: state === "unlocked" ? "#E7E5FF" : undefined,
          backgroundImage: state === "unlocked" ? undefined : "repeating-linear-gradient(45deg,#ECECEF 0 10px,#F1F1F3 10px 20px)",
        }}
      >
        {state === "unlocked" ? <span className="text-[13px] font-semibold text-[#3326B8]">Unlocked</span> : null}
        {state !== "unlocked" ? (
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-ground text-ink">
            <IconLock />
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[15px] font-semibold">{title}</span>
          <span className="shrink-0 text-[14px] font-semibold tabular-nums">{price}</span>
        </div>
        <p className="text-[13px] leading-snug text-muted-2">{teaser}</p>
        {state === "expired" ? <span className="text-[13px] text-muted">This offer has expired.</span> : action}
      </div>
    </div>
  );
}
