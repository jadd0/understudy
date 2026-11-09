import { BalanceSkeleton, RecentActivitySkeleton, Section, SpendingLimitSkeleton, TopUpSkeleton, WalletFrame } from "./sections";

export default function Loading() {
  return (
    <WalletFrame>
      <BalanceSkeleton />
      <Section title="Top up">
        <TopUpSkeleton />
      </Section>
      <Section title="Daily spending limit">
        <SpendingLimitSkeleton />
      </Section>
      <Section title="Recent activity">
        <RecentActivitySkeleton />
      </Section>
    </WalletFrame>
  );
}
