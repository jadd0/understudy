import {
  AiSwitchSkeleton,
  CataloguePricesSkeleton,
  HINTS,
  NeverListSkeleton,
  PersonaCardSkeleton,
  Section,
  SettingsFrame,
} from "./sections";

export default function Loading() {
  return (
    <SettingsFrame>
      <Section title="AI answers" hint={HINTS.ai}>
        <AiSwitchSkeleton />
      </Section>
      <Section title="Never talk about" hint={HINTS.never}>
        <NeverListSkeleton />
      </Section>
      <Section title="Catalogue prices" hint={HINTS.prices}>
        <CataloguePricesSkeleton />
      </Section>
      <Section title="Persona card" hint={HINTS.card}>
        <PersonaCardSkeleton />
      </Section>
    </SettingsFrame>
  );
}
