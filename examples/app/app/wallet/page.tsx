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
};

export default async function WalletPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  // The guard decides before anything streams; each section then streams on its own.
  const user = await requireAdultFan();
  const fanId = user.id;
  const params = await searchParams;
  const entries = Object.entries(params).map(([k, v]) => `${k}=${v}`);
  const notice = entries.map((e) => NOTICES[e]).find(Boolean);
  const problem = entries.map((e) => ERRORS[e]).find(Boolean);

  return (
    <WalletFrame>
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
          <TopUpForms />
        </Suspense>
      </Section>

      <Section title="Daily spending limit">
        <Suspense fallback={<SpendingLimitSkeleton />}>
          <SpendingLimit fanId={fanId} />
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
