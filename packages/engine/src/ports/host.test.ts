import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeDecider } from "../testing/fakes/decider.js";
import { DeciderUnavailable } from "./decider.js";
import { FakeHost } from "../testing/fake-host.js";
import { buildOwnedShortlist, buildShortlist, pickOffer, type ShortlistItem } from "../conversation/offer.js";

const ROOT = process.cwd();
const sourceFiles = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(rel);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !/(^|\/)testing\/(?!fakes\/)[^/]+\.ts$/.test(rel) ? [rel] : [];
  });

// Host tables the engine must not name, in code or in raw SQL (the commit and lease files included).
// `unlocks` and `users` are also property and column words, so they count only as SQL tables or drizzle imports.
const HOST_TABLES = [
  /\bledger_entries\b/,
  /\bwallets\b/,
  /\bcatalogue_items\b/,
  /\b(from|join|into|update)\s+(unlocks|users)\b/i,
  /\.(update|insert|delete)\((users|unlocks|wallets|ledgerEntries|catalogueItems)\)/,
  /\bimport\s*\{[^}]*\b(users|unlocks|wallets|ledgerEntries|catalogueItems)\b[^}]*\}\s*from\s*"@\/db\/schema"/,
];

describe("the engine's host boundary", () => {
  test("the engine package source files import nothing from @/lib/wallet and name no host table", () => {
    const files = sourceFiles("packages/engine/src");
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain("packages/engine/src/turn/run.ts");
    const offenders: string[] = [];
    for (const f of files) {
      // Comments may name a host table in prose; code and SQL may not.
      const code = readFileSync(join(ROOT, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      if (/@\/lib\/wallet/.test(code)) offenders.push(`${f}: imports @/lib/wallet`);
      for (const t of HOST_TABLES) if (t.test(code)) offenders.push(`${f}: names ${t.source}`);
      if (/\bcreators\b/.test(code)) offenders.push(`${f}: names creators`);
    }
    expect(offenders).toEqual([]);
  });

  test("host.ts imports nothing from the app", () => {
    const code = readFileSync(join(ROOT, "packages/engine/src/ports/host.ts"), "utf8");
    expect(code.match(/^import .*$/gm) ?? []).toEqual([]);
  });
});

describe("a host with nothing to offer", () => {
  const item = (id: string, over: Partial<ShortlistItem> = {}): ShortlistItem => ({ id, kind: "ppv", title: id, teaser: null, priceCents: 500, ...over });
  const q = { creatorId: "c", fanId: "f", conversationId: "v" };

  test("a fan who owns the whole catalogue and a creator with no re-offerable item leaves nothing to pick", async () => {
    const host = new FakeHost({ items: [], owned: [] });
    const unowned = await buildShortlist(host, q.creatorId, q.fanId, q.conversationId);
    const owned = await buildOwnedShortlist(host, q.creatorId, q.fanId, q.conversationId);
    expect([...unowned, ...owned]).toEqual([]);
    await expect(pickOffer(new FakeDecider(), [...unowned, ...owned], "s")).rejects.toBeInstanceOf(DeciderUnavailable);
  });

  test("the fake splits the catalogue by ownership and honours kinds", async () => {
    const host = new FakeHost({ items: [item("a"), item("b", { kind: "bundle" }), item("c")], owned: ["c"] });
    expect((await buildShortlist(host, "c", "f", "v")).map((i) => i.id)).toEqual(["a", "b"]);
    expect((await buildShortlist(host, "c", "f", "v", ["bundle"])).map((i) => i.id)).toEqual(["b"]);
    expect((await buildOwnedShortlist(host, "c", "f", "v")).map((i) => [i.id, i.owned])).toEqual([["c", true]]);
    expect(await host.catalogue.ownsEverything("c", "f")).toBe(false);
    host.owned.add("a");
    host.owned.add("b");
    expect(await host.catalogue.ownsEverything("c", "f")).toBe(true);
  });
});
