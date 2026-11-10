import { Suspense } from "react";
import { notFound } from "next/navigation";
import { FormAlert } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { requireConsole } from "@/lib/auth/guards";
import { consoleCreatorFor } from "@/lib/conversations/read";
import { chatter } from "@/lib/host/deps";
import { saveGlobalAi } from "../actions";
import {
  AddItemForm,
  CatalogueEditor,
  CatalogueEditorSkeleton,
  HINTS,
  latestCard,
  NeverList,
  NeverListSkeleton,
  PersonaCard,
  PersonaCardSkeleton,
  Section,
  SettingsFrame,
} from "./sections";

export const dynamic = "force-dynamic";

const SAVED: Record<string, string> = {
  ai: "AI switch saved. The next message uses it.",
  never: "Never-list saved. The next message is checked against it.",
  price: "Price saved. The next offer uses it; offers already open keep their price.",
  item_added: "Item added at the end of the catalogue.",
  item_retired: "Item retired. It will not be offered again.",
  item_restored: "Item restored.",
  item_moved: "Order saved.",
};
const ERRORS: Record<string, string> = {
  ai: "Could not save the AI switch.",
  never: "Could not save the list: each term is at most 80 characters and there are at most 100.",
  price: "Enter a price as dollars and cents, above $0 (for example 14.99).",
  item_price: "Enter the price as dollars and cents, above $0 (for example 14.99).",
  item: "Could not add the item: a kind, a title of at most 80 characters, a teaser of at most 200 and a price above $0 are needed.",
  item_edit: "Could not change that item.",
};

export default async function ConsoleSettingsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  // An admin edits the settings of the creator its console opens. The guard and the creator lookup (a 404
  // without one) decide before anything streams; the sections then stream behind their skeletons.
  const user = await requireConsole();
  const creator = await consoleCreatorFor({ id: user.id, role: user.role });
  if (!creator) notFound();
  const aiEnabled = await (await chatter()).creatorAi(creator.id);
  const p = await searchParams;
  // Started once, awaited by the two sections that read it.
  const card = latestCard(creator.id);

  return (
    <SettingsFrame>
      {p.saved && SAVED[p.saved] ? <p role="status" className="rounded-field bg-surface px-3 py-2 text-[14px]">{SAVED[p.saved]}</p> : null}
      {p.error && ERRORS[p.error] ? <FormAlert>{ERRORS[p.error]}</FormAlert> : null}

      <Section title="AI answers" hint={HINTS.ai}>
        <form action={saveGlobalAi} className="flex items-center justify-between gap-4 rounded-row border border-line px-4 py-3">
          <span className="text-[15px] font-medium">{aiEnabled ? "AI is answering your fans" : "AI is off"}</span>
          <Switch on={aiEnabled} name="ai" label="AI answers for all conversations" />
        </form>
      </Section>

      <Section title="Never talk about" hint={HINTS.never}>
        <Suspense fallback={<NeverListSkeleton />}>
          <NeverList card={card} />
        </Suspense>
      </Section>

      <Section title="Catalogue" hint={HINTS.catalogue}>
        <Suspense fallback={<CatalogueEditorSkeleton />}>
          <CatalogueEditor creatorId={creator.id} />
        </Suspense>
        <AddItemForm />
      </Section>

      <Section title="Persona card" hint={HINTS.card}>
        <Suspense fallback={<PersonaCardSkeleton />}>
          <PersonaCard card={card} />
        </Suspense>
      </Section>
    </SettingsFrame>
  );
}
