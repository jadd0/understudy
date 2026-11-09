import { Skeleton, SkeletonAvatar, SkeletonBubble, SkeletonGroup, SkeletonLine } from "@/components/ui/skeleton";

/** A short exchange, newest at the bottom like the real thread once it scrolls down. */
const BUBBLES: { side: "me" | "them"; width: number }[] = [
  { side: "them", width: 220 },
  { side: "them", width: 150 },
  { side: "me", width: 190 },
  { side: "them", width: 260 },
  { side: "me", width: 120 },
  { side: "me", width: 210 },
];

/**
 * `LiveThread`'s main column while the thread streams: the header, a few bubbles and the composer, at the
 * real component's sizes so the header and the composer do not move when the thread arrives. `staff` adds the
 * console's takeover bar; `fan` the fan's wallet button and the composer's taller Tip button.
 */
export function ThreadSkeleton({ staff = false, fan = false }: { staff?: boolean; fan?: boolean }) {
  return (
    <SkeletonGroup label="Loading conversation" className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* ChatHeader: 38px avatar (42 on desktop), a 16px name line and a 12px (13px) status line. */}
      <div className="flex h-[65px] shrink-0 items-center gap-2 border-b border-line pr-1.5 pl-3 md:h-[69.5px] md:gap-3 md:pr-3.5 md:pl-6">
        <SkeletonAvatar size={38} className="md:hidden" />
        <SkeletonAvatar size={42} className="hidden md:block" />
        <span className="ml-0.5 flex min-w-0 flex-1 flex-col gap-px md:ml-0">
          <SkeletonLine width={128} lineHeight={24} bar={12} />
          <SkeletonLine width={80} lineHeight={19.5} bar={9} />
        </span>
        {fan ? <Skeleton className="h-11 w-11 rounded-full" /> : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden px-3 pt-1 pb-2 md:px-6 md:pt-2">
        <div className="mx-auto flex w-full max-w-[760px] flex-col">
          {BUBBLES.map((b, i) => (
            <SkeletonBubble key={i} side={b.side} width={b.width} />
          ))}
          <span className="h-3" />
        </div>
      </div>
      {staff ? (
        <div className="mx-auto w-full max-w-[760px] px-3 md:px-6">
          <Skeleton className="mb-2 h-[54px] w-full rounded-[20px]" />
        </div>
      ) : null}
      {/* Composer: the pill's outline is drawn as is; only its contents wait. */}
      <div className="px-3 pt-2 pb-7 md:px-6 md:pt-2.5 md:pb-[22px]">
        <div className="mx-auto max-w-[760px]">
          <div
            className={`flex items-center rounded-pill border border-line p-1 pl-4 md:p-[5px] md:pl-4 ${fan ? "min-h-[54px] md:min-h-[56px]" : "min-h-[52px] md:min-h-[54px]"}`}
          >
            <SkeletonLine width="38%" lineHeight={42} bar={10} />
          </div>
        </div>
      </div>
    </SkeletonGroup>
  );
}
