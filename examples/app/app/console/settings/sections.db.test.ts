import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { db } from "@/db/client";
import { catalogueItems } from "@/db/schema";
import { makeCreator, makeItem } from "@jadd0/understudy-engine/testing";
import { offerableItems } from "@/lib/conversations/read";
import { eq } from "drizzle-orm";

// The server actions are not under test: the page markup is.
vi.mock("../actions", () => ({
  addItemAction: vi.fn(),
  moveItemAction: vi.fn(),
  restoreItemAction: vi.fn(),
  retireItemAction: vi.fn(),
  saveNeverList: vi.fn(),
  savePrice: vi.fn(),
}));

const { AddItemForm, CatalogueEditor } = await import("./sections");
const Loading = (await import("./loading")).default;

const forms = (html: string) => html.match(/<form[\s\S]*?<\/form>/g) ?? [];

describe("catalogue editor markup", () => {
  test("Up, Down and Retire sit in their own forms, outside the price form", async () => {
    const creator = await makeCreator();
    const [a, b] = [await makeItem(creator.id, { title: "Alpha" }), await makeItem(creator.id, { title: "Beta" })];
    const html = renderToStaticMarkup(await CatalogueEditor({ creatorId: creator.id }));
    const all = forms(html);
    const priceForms = all.filter((f) => f.includes('name="price"'));
    expect(priceForms).toHaveLength(2);
    // a price typed but not saved must not travel with a move or a retire
    for (const f of priceForms) {
      expect(f).not.toContain('name="direction"');
      expect(f).not.toContain("Retire");
      expect(f).not.toContain("Move ");
    }
    const movers = all.filter((f) => f.includes('name="direction"'));
    expect(movers).toHaveLength(4);
    for (const f of movers) {
      expect(f).not.toContain('name="price"');
      expect(f).toMatch(/name="itemId"/);
    }
    const retires = all.filter((f) => f.includes("Retire "));
    expect(retires).toHaveLength(2);
    for (const f of retires) expect(f).not.toContain('name="price"');
    // each item's forms name that item
    for (const item of [a, b]) {
      expect(all.filter((f) => f.includes(`value="${item.id}"`))).toHaveLength(4);
    }
  });

  test("the editor, the offer picker and a tie between places list items in one order", async () => {
    const creator = await makeCreator();
    // all at position 0, as the migration leaves them: the title breaks the tie
    for (const title of ["Mango", "Apple", "Cherry"]) await makeItem(creator.id, { title });
    const html = renderToStaticMarkup(await CatalogueEditor({ creatorId: creator.id }));
    const shown = [...html.matchAll(/<span class="truncate text-\[15px\] font-medium">([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(shown).toEqual(["Apple", "Cherry", "Mango"]);
    expect((await offerableItems(creator.id)).map((i) => i.title)).toEqual(shown);
    // a place she set outranks the title
    await db.update(catalogueItems).set({ position: 1 }).where(eq(catalogueItems.title, "Apple"));
    const again = renderToStaticMarkup(await CatalogueEditor({ creatorId: creator.id }));
    const shownAgain = [...again.matchAll(/<span class="truncate text-\[15px\] font-medium">([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(shownAgain.length).toBeGreaterThan(0);
    expect(shownAgain).toEqual((await offerableItems(creator.id)).map((i) => i.title));
  });
});

describe("the loading screen's add form", () => {
  test("is a disabled copy that cannot be typed into or submitted, and the live form is not", () => {
    const live = renderToStaticMarkup(createElement(AddItemForm));
    expect(live).not.toContain("<fieldset disabled");
    const copy = renderToStaticMarkup(createElement(AddItemForm, { disabled: true }));
    expect(copy).toContain("<fieldset disabled");
    expect(copy).toContain("Add item");
    // same fields as the live one, so the screen does not jump when the page arrives
    expect(copy.match(/<(input|select)\b/g)).toEqual(live.match(/<(input|select)\b/g));
  });

  test("loading.tsx renders no live add form", () => {
    const html = renderToStaticMarkup(createElement(Loading));
    const add = forms(html).filter((f) => f.includes("Add item"));
    expect(add).toHaveLength(1);
    expect(add[0]).toContain("<fieldset disabled");
  });
});
