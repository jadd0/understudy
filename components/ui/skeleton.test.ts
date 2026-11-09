import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Skeleton, SkeletonAvatar, SkeletonGroup, SkeletonRows } from "./skeleton";

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("skeleton kit", () => {
  it("renders the asked number of thread rows, each 48px avatar plus two lines", () => {
    const html = renderToStaticMarkup(createElement(SkeletonRows, { count: 5 }));
    // One avatar block and two line blocks per row.
    expect(count(html, "data-skeleton")).toBe(15);
    expect(count(html, "width:48px;height:48px")).toBe(5);
  });

  it("hides every block from assistive tech and stops the pulse under reduced motion", () => {
    const html = renderToStaticMarkup(createElement(Skeleton, { className: "h-11" }));
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("animate-pulse");
    expect(html).toContain("motion-reduce:animate-none");
  });

  it("puts a display class on a wrapper so it cannot fight the block's own display", () => {
    const html = renderToStaticMarkup(createElement(SkeletonAvatar, { size: 42, className: "hidden md:block" }));
    expect(html.startsWith('<span class="shrink-0 hidden md:block">')).toBe(true);
  });

  it("announces a loading section once, as busy", () => {
    const html = renderToStaticMarkup(createElement(SkeletonGroup, { label: "Loading balance" }, createElement(SkeletonRows, { count: 2 })));
    expect(html).toContain('aria-busy="true"');
    expect(count(html, 'role="status"')).toBe(1);
    expect(html).toContain("Loading balance");
  });
});
