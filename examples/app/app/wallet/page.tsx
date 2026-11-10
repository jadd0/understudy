import { Suspense } from "react";
import { FormAlert } from "@/components/ui/field";
import { requireAdultFan } from "@/lib/auth/guards";
import {
  Balance,
  BalanceSkeleton,
  RecentActivity,
  RecentActivitySkeleton,
  Section,
  SpendingLimit,
  SpendingLimitSkeleton,
  TopUpForms,
  TopUpSkeleton,
  WalletFrame,
} from "./sections";
import { cameFrom, chatHrefFor } from "./chat-link";

export const dynamic = "force-dynamic";

const NOTICES: Record<string, string> = {
  "topup=processing": "Payment received, your balance updates in a moment.",
  "topup=cancelled": "Top-up cancelled.",
  "cap=set": "Daily limit updated.",
  "cap=pending": "Raising your limit takes effect after the cooling-off period.",
};
const ERRORS: Record<string, string> = {
  "error=amount": "Enter a whole-dollar or cent amount within the allowed range.",
  "error=cap": "Enter an amount at or above the minimum limit.",
  "error=stripe": "Could not start the payment. Try again.",
  "error=topups-off": "Top-ups are off on this install.",
};

export default async function WalletPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  // The guard decides before anything streams; each section then streams on its own.
  const user = await requireAdultFan();
  const fanId = user.id;
  const params = await searchParams;
  // `?c=<handle>` is the chat the fan came from. It is checked here as the chat page checks it: a handle nobody can
  // reach, or a repeated one, sends the fan back to plain `/chat`.
  const { c } = params as Record<string, string | string[] | undefined>;
  const handle = (await cameFrom(fanId, c)) ?? undefined;
  const entries = Object.entries(params).filter(([k]) => k !== "c").map(([k, v]) => `${k}=${v}`);
  const notice = entries.map((e) => NOTICES[e]).find(Boolean);
  const problem = entries.map((e) => ERRORS[e]).find(Boolean);

  return (
    <WalletFrame chatHref={chatHrefFor(handle)}>
      {notice ? (
        <p role="status" className="rounded-field bg-surface px-3 py-2 text-[14px]">
          {notice}
        </p>
      ) : null}
      {problem ? <FormAlert>{problem}</FormAlert> : null}

      <Suspense fallback={<BalanceSkeleton />}>
        <Balance fanId={fanId} />
      </Suspense>

      <Section title="Top up">
        <Suspense fallback={<TopUpSkeleton />}>
          <TopUpForms handle={handle} />
        </Suspense>
      </Section>

      <Section title="Daily spending limit">
        <Suspense fallback={<SpendingLimitSkeleton />}>
          <SpendingLimit fanId={fanId} handle={handle} />
        </Suspense>
      </Section>

      <Section title="Recent activity">
        <Suspense fallback={<RecentActivitySkeleton />}>
          <RecentActivity fanId={fanId} />
        </Suspense>
      </Section>
    </WalletFrame>
  );
}
