import type { ReactNode } from "react";
import Link from "next/link";
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db/client";
import { catalogueItems, personaCards } from "@/db/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconBack } from "@/components/ui/icons";
import { Skeleton, SkeletonGroup, SkeletonLine } from "@/components/ui/skeleton";
import { formatCents } from "@/lib/wallet/money";
import { Field } from "@/components/ui/field";
import { MAX_ITEM_TEASER_CHARS, MAX_ITEM_TITLE_CHARS } from "@/lib/conversations/controls";
import { addItemAction, moveItemAction, restoreItemAction, retireItemAction, saveNeverList, savePrice } from "../actions";

/*
 * Console settings: the frame, and the sections that stream. The page renders the frame and the AI switch
 * (its value comes with the creator row the guard step already read); the never-list, catalogue and persona card
 * stream behind their skeletons. loading.tsx renders the same frame with every skeleton.
 */

type Card = typeof personaCards.$inferSelect;

/** The creator's published persona card, newest version; one query shared by the never-list and the card section. */
export async function latestCard(creatorId: string): Promise<Card | null> {
  const [card] = await db
    .select()
    .from(personaCards)
    .where(and(eq(personaCards.creatorId, creatorId), isNotNull(personaCards.publishedAt)))
    .orderBy(desc(personaCards.version))
    .limit(1);
  return card ?? null;
}

export function SettingsFrame({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-[640px] flex-col gap-6 px-4 py-6 md:py-10">
      <header className="flex flex-col gap-3">
        <Link href="/console" className="inline-flex h-11 w-fit items-center gap-1 text-[14px] font-medium text-muted-2 hover:text-ink">
          <IconBack /> Inbox
        </Link>
        <h1 className="text-[28px] font-semibold tracking-[-0.02em]">Settings</h1>
      </header>
      {children}
    </main>
  );
}

export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-[17px] font-semibold tracking-[-0.01em]">{title}</h2>
        {hint ? <p className="text-[14px] leading-relaxed text-muted-2">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

export const HINTS = {
  ai: "Off means every conversation waits for you. Each conversation also has its own switch in the thread.",
  never: "One term per line. A reply that contains a term is rejected and held for you instead.",
  catalogue: "What you can offer. Prices are in dollars and a new price applies to offers made from now on. A retired item is never offered again; an offer already open on it can still be unlocked.",
  card: "How the creator sounds. Read-only here; it changes through a new card version.",
};

/** The AI switch row while the creator row loads (loading.tsx only; the page has the row before it renders). */
export function AiSwitchSkeleton() {
  return (
    <SkeletonGroup label="Loading AI switch">
      <div className="flex items-center justify-between gap-4 rounded-row border border-line px-4 py-3">
        <SkeletonLine width={180} lineHeight={22.5} bar={11} />
        <Skeleton className="h-7 w-12 rounded-full" />
      </div>
    </SkeletonGroup>
  );
}

export async function NeverList({ card }: { card: Promise<Card | null> }) {
  const c = await card;
  return (
    <form action={saveNeverList} className="flex flex-col gap-3">
      <label htmlFor="terms" className="sr-only">
        Never talk about
      </label>
      <textarea
        id="terms"
        name="terms"
        rows={5}
        defaultValue={(c?.neverList ?? []).join("\n")}
        className="rounded-field border border-transparent bg-surface p-3 text-[16px] outline-none focus:border-line-focus focus:bg-ground md:text-[15px]"
      />
      <Button className="w-fit">Save list</Button>
    </form>
  );
}

/** Five textarea rows (about 146px with its padding) and the Save button. */
export function NeverListSkeleton() {
  return (
    <SkeletonGroup label="Loading never-list" className="flex flex-col gap-3">
      <Skeleton className="h-[146px] w-full rounded-field md:h-[138px]" />
      <Skeleton className="h-11 w-[108px] rounded-full" />
    </SkeletonGroup>
  );
}

export async function CatalogueEditor({ creatorId }: { creatorId: string }) {
  const items = await db
    .select()
    .from(catalogueItems)
    .where(eq(catalogueItems.creatorId, creatorId))
    .orderBy(asc(catalogueItems.position), asc(catalogueItems.title), asc(catalogueItems.id));
  const live = items.filter((i) => i.active);
  const retired = items.filter((i) => !i.active);
  return (
    <div className="flex flex-col gap-6">
      {live.length === 0 ? <p className="text-[14px] text-muted">No items yet. Add one below.</p> : null}
      <ul className="flex flex-col gap-2">
        {live.map((i, n) => (
          <li key={i.id}>
            <form action={savePrice} className="flex flex-wrap items-center gap-3 rounded-row border border-line px-4 py-3">
              <input type="hidden" name="itemId" value={i.id} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[15px] font-medium">{i.title}</span>
                <span className="text-[13px] text-muted">
                  {i.kind} · now {formatCents(i.priceCents)}
                </span>
              </span>
              <label htmlFor={`price-${i.id}`} className="sr-only">
                Price for {i.title} in dollars
              </label>
              <span className="text-muted">$</span>
              <input
                id={`price-${i.id}`}
                name="price"
                inputMode="decimal"
                defaultValue={(i.priceCents / 100).toFixed(2)}
                className="h-11 w-24 rounded-field border border-transparent bg-surface px-3 text-[16px] tabular-nums outline-none focus:border-line-focus focus:bg-ground md:text-[15px]"
              />
              <Button variant="secondary">Save</Button>
              <span className="flex basis-full flex-wrap items-center gap-2">
                <Button variant="quiet" type="submit" formAction={moveItemAction} name="direction" value="up" disabled={n === 0} aria-label={`Move ${i.title} up`}>
                  Up
                </Button>
                <Button variant="quiet" type="submit" formAction={moveItemAction} name="direction" value="down" disabled={n === live.length - 1} aria-label={`Move ${i.title} down`}>
                  Down
                </Button>
                <Button variant="quiet" type="submit" formAction={retireItemAction} aria-label={`Retire ${i.title}`}>
                  Retire
                </Button>
              </span>
            </form>
          </li>
        ))}
      </ul>

      {retired.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-[14px] font-semibold text-muted-2">Retired</h3>
          <ul className="flex flex-col gap-2">
            {retired.map((i) => (
              <li key={i.id}>
                <form action={restoreItemAction} className="flex flex-wrap items-center gap-3 rounded-row border border-line px-4 py-3">
                  <input type="hidden" name="itemId" value={i.id} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[15px] font-medium text-muted-2">{i.title}</span>
                    <span className="text-[13px] text-muted">
                      {i.kind} · {formatCents(i.priceCents)}
                    </span>
                  </span>
                  <Button variant="secondary" aria-label={`Restore ${i.title}`}>
                    Restore
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** The new-item form; it needs no data, so it renders at once beside the streaming list. */
export function AddItemForm() {
  return (
    <form action={addItemAction} className="flex flex-col gap-3 rounded-row border border-line px-4 py-4">
      <h3 className="text-[15px] font-semibold">Add item</h3>
      <label htmlFor="item-kind" className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-ink-2">Kind</span>
        <select
          id="item-kind"
          name="kind"
          defaultValue="ppv"
          className="h-11 rounded-field border border-transparent bg-surface px-3 text-[16px] outline-none focus:border-line-focus focus:bg-ground md:text-[15px]"
        >
          <option value="ppv">ppv</option>
          <option value="bundle">bundle</option>
          <option value="personal">personal</option>
        </select>
      </label>
      <Field id="item-title" name="title" label="Title" required maxLength={MAX_ITEM_TITLE_CHARS} autoComplete="off" />
      <Field id="item-teaser" name="teaser" label="Teaser (optional)" maxLength={MAX_ITEM_TEASER_CHARS} autoComplete="off" />
      <Field id="item-price" name="price" label="Price in dollars" inputMode="decimal" required placeholder="9.99" autoComplete="off" />
      <Button className="w-fit">Add item</Button>
    </form>
  );
}

/** Item rows in their bordered frames: title and kind lines, the $ field and the Save button, then the move and retire row. */
export function CatalogueEditorSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <SkeletonGroup label="Loading catalogue" className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex flex-wrap items-center gap-3 rounded-row border border-line px-4 py-3">
          <span className="flex min-w-0 flex-1 flex-col">
            <SkeletonLine width={["52%", "40%", "60%", "46%"][i % 4]} lineHeight={22.5} bar={11} />
            <SkeletonLine width="34%" lineHeight={19.5} bar={9} />
          </span>
          <Skeleton className="h-11 w-[108px] rounded-field" />
          <Skeleton className="h-11 w-[84px] rounded-full" />
          <span className="flex basis-full gap-2">
            <Skeleton className="h-11 w-[68px] rounded-full" />
            <Skeleton className="h-11 w-[84px] rounded-full" />
            <Skeleton className="h-11 w-[92px] rounded-full" />
          </span>
        </div>
      ))}
    </SkeletonGroup>
  );
}

export async function PersonaCard({ card }: { card: Promise<Card | null> }) {
  const c = await card;
  if (!c) return <p className="text-[14px] text-muted">No card loaded yet.</p>;
  return (
    <div className="flex flex-col gap-2">
      <Badge>Version {c.version}</Badge>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-field bg-surface p-3 text-[13px] leading-relaxed text-ink-2">{c.body}</pre>
    </div>
  );
}

/** The version chip and the card's 288px scroll box (`max-h-72`), which a published card fills. */
export function PersonaCardSkeleton() {
  return (
    <SkeletonGroup label="Loading persona card" className="flex flex-col gap-2">
      <Skeleton className="h-[20.5px] w-[72px] rounded-full" />
      <Skeleton className="h-72 w-full rounded-field" />
    </SkeletonGroup>
  );
}
