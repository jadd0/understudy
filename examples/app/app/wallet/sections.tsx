import type { ReactNode } from "react";
import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { ledgerEntries, wallets } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { IconBack } from "@/components/ui/icons";
import { LocalTime } from "@/components/ui/local-time";
import { Skeleton, SkeletonField, SkeletonGroup, SkeletonLine } from "@/components/ui/skeleton";
import { getConfig } from "@/lib/config";
import { getFanCap } from "@/lib/wallet/cap";
import { formatCents } from "@/lib/wallet/money";
import { stripeConfigured } from "@/lib/env";
import { changeCap, topUp } from "./actions";

/*
 * The wallet's frame and its four streamed sections. The page renders the frame and wraps each section in
 * Suspense with the matching skeleton; loading.tsx renders the same frame with every skeleton.
 */

const KIND: Record<string, string> = { topup: "Top-up", unlock: "Unlock", tip: "Tip", refund: "Refund", grant: "Welcome credit" };

// In the viewer's timezone, like the chat: the server cannot know it, so the browser fills the time in.
const when = (d: Date) => <LocalTime iso={d.toISOString()} />;
const signed = (cents: number) => `${cents < 0 ? "−" : "+"}${formatCents(Math.abs(cents))}`;

/** `chatHref` is the chat the fan came from (`/chat?c=<handle>`); the wallet page validates the handle before passing it. */
export function WalletFrame({ children, chatHref = "/chat" }: { children: ReactNode; chatHref?: string }) {
  return (
    <main className="mx-auto flex w-full max-w-[480px] flex-col gap-6 px-4 py-6 md:py-10">
      <header className="flex flex-col gap-3">
        <Link href={chatHref} className="inline-flex h-11 w-fit items-center gap-1 text-[14px] font-medium text-muted-2 hover:text-ink">
          <IconBack /> Messages
        </Link>
        <h1 className="text-[28px] font-semibold tracking-[-0.02em]">Wallet</h1>
      </header>
      {children}
    </main>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-6">
      <h2 className="text-[17px] font-semibold tracking-[-0.01em]">{title}</h2>
      {children}
    </section>
  );
}

/** The balance card; its label is part of the frame, only the amount waits. */
function BalanceCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-bubble bg-surface px-5 py-5">
      <span className="text-[13px] font-medium text-muted-2">Balance</span>
      {children}
    </div>
  );
}

export async function Balance({ fanId }: { fanId: string }) {
  const [wallet] = await db.select().from(wallets).where(eq(wallets.fanId, fanId));
  return (
    <BalanceCard>
      <span className="text-[40px] leading-none font-semibold tracking-[-0.03em] tabular-nums">{formatCents(wallet?.balanceCents ?? 0)}</span>
    </BalanceCard>
  );
}

export function BalanceSkeleton() {
  return (
    <BalanceCard>
      <SkeletonGroup label="Loading balance">
        <SkeletonLine width={132} lineHeight={40} bar={30} tone="strong" />
      </SkeletonGroup>
    </BalanceCard>
  );
}

/** `handle` is the chat the fan came from, already checked by the page; the forms post it back so the way home survives. */
export async function TopUpForms({ handle }: { handle?: string } = {}) {
  if (!stripeConfigured()) return <p className="text-[14px] text-muted-2">Top-ups are off on this install.</p>;
  const [presets, min, max] = await Promise.all([
    getConfig<number[]>("wallet.topup_options_cents"),
    getConfig<number>("wallet.topup_min_cents"),
    getConfig<number>("wallet.topup_max_cents"),
  ]);
  return (
    <>
      <form action={topUp} className="grid grid-cols-3 gap-2">
        {handle ? <input type="hidden" name="c" value={handle} /> : null}
        {presets.map((c) => (
          <Button key={c} name="preset" value={c} variant="secondary" className="px-0">
            {formatCents(c)}
          </Button>
        ))}
      </form>
      <form action={topUp} className="flex items-end gap-2">
        {handle ? <input type="hidden" name="c" value={handle} /> : null}
        <div className="flex-1">
          <Field id="custom" name="custom" label="Custom amount ($)" inputMode="decimal" placeholder={String(min / 100)} required hint={`${formatCents(min)} to ${formatCents(max)}`} />
        </div>
        <Button className="mb-[22px]">Top up</Button>
      </form>
    </>
  );
}

/** A field with its button, as the top-up and limit forms lay them out. `wrapHint`: the hint takes two lines on a phone. */
function FieldRowSkeleton({ labelWidth, button, wrapHint = false }: { labelWidth: number; button: number; wrapHint?: boolean }) {
  return (
    <div className="flex items-end gap-2">
      <div className="flex-1">
        <SkeletonField labelWidth={labelWidth} />
        {wrapHint ? <SkeletonLine width="40%" lineHeight={18} bar={8} className="min-[460px]:hidden" /> : null}
      </div>
      <Skeleton className="mb-[22px] h-11 rounded-full" style={{ width: button }} />
    </div>
  );
}

export function TopUpSkeleton() {
  return (
    <SkeletonGroup label="Loading top-up options" className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-11 rounded-full" />
        ))}
      </div>
      <FieldRowSkeleton labelWidth={116} button={88} />
    </SkeletonGroup>
  );
}

export async function SpendingLimit({ fanId, handle }: { fanId: string; handle?: string }) {
  const [capMin, cap] = await Promise.all([getConfig<number>("wallet.cap_min_cents"), getFanCap(fanId)]);
  return (
    <>
      <p className="text-[15px]">
        Current limit <span className="font-semibold tabular-nums">{formatCents(cap.effectiveCents)}</span>
      </p>
      {cap.pending ? (
        <p className="text-[14px] text-muted-2">
          Raising to {formatCents(cap.pending.cents)} takes effect {when(cap.pending.at)}.
        </p>
      ) : null}
      <form action={changeCap} className="flex items-end gap-2">
        {handle ? <input type="hidden" name="c" value={handle} /> : null}
        <div className="flex-1">
          <Field id="cap" name="cap" label="New limit ($)" inputMode="decimal" placeholder={String(capMin / 100)} required hint="Lowering applies now. Raising applies after 24 hours." />
        </div>
        <Button variant="secondary" className="mb-[22px]">
          Set limit
        </Button>
      </form>
    </>
  );
}

export function SpendingLimitSkeleton() {
  return (
    <SkeletonGroup label="Loading spending limit" className="flex flex-col gap-3">
      <SkeletonLine width={168} lineHeight={22.5} bar={11} />
      <FieldRowSkeleton labelWidth={76} button={102} wrapHint />
    </SkeletonGroup>
  );
}

export async function RecentActivity({ fanId }: { fanId: string }) {
  const recent = await db.select().from(ledgerEntries).where(eq(ledgerEntries.fanId, fanId)).orderBy(desc(ledgerEntries.createdAt)).limit(20);
  if (recent.length === 0) return <p className="text-[14px] text-muted">Nothing yet.</p>;
  return (
    <ul className="flex flex-col">
      {recent.map((e) => (
        <li key={e.id} className="flex items-center justify-between gap-3 border-b border-line py-3 last:border-0">
          <span className="flex flex-col">
            <span className="text-[15px] font-medium">{KIND[e.kind] ?? e.kind}</span>
            <span className="text-[13px] text-muted">{when(e.createdAt)}</span>
          </span>
          <span className="text-[15px] font-semibold tabular-nums">{signed(e.kind === "topup" || e.kind === "refund" || e.kind === "grant" ? Math.abs(e.amountCents) : -Math.abs(e.amountCents))}</span>
        </li>
      ))}
    </ul>
  );
}

/** Rows shaped like a ledger line: kind and time on the left, the amount on the right, 67px tall. */
export function RecentActivitySkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <SkeletonGroup label="Loading recent activity" className="flex flex-col">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center justify-between gap-3 border-b border-line py-3 last:border-0">
          <span className="flex flex-col">
            <SkeletonLine width={[72, 96, 60, 84][i % 4]} lineHeight={22.5} bar={11} />
            <SkeletonLine width={112} lineHeight={19.5} bar={9} />
          </span>
          <SkeletonLine width={56} lineHeight={22.5} bar={11} />
        </div>
      ))}
    </SkeletonGroup>
  );
}
