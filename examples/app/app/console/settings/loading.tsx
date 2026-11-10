import {
  AddItemForm,
  AiSwitchSkeleton,
  CatalogueEditorSkeleton,
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
      <Section title="Catalogue" hint={HINTS.catalogue}>
        <CatalogueEditorSkeleton />
        <AddItemForm disabled />
      </Section>
      <Section title="Persona card" hint={HINTS.card}>
        <PersonaCardSkeleton />
      </Section>
    </SettingsFrame>
  );
}
