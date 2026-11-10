import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { personaChunks } from "@jadd0/understudy-engine/schema";
import { makeCreator } from "@jadd0/understudy-engine/testing";
import { parseStrategy, PersonaRetriever, promptText } from "./persona-retriever.js";

const unit = (i: number) => Array.from({ length: 1024 }, (_, j) => (j === i ? 1 : 0));

async function seed() {
  const c = await makeCreator();
  await db.insert(personaChunks).values([
    { creatorId: c.id, source: "caption", text: "my cat sleeps on my keyboard", meta: { chunk_id: "cat" }, embedding: unit(0) },
    { creatorId: c.id, source: "caption", text: "tokyo trip with friends", meta: { chunk_id: "tokyo" }, embedding: unit(1) },
  ]);
  return c;
}

describe("PersonaRetriever", () => {
  test("vector finds the chunk by meaning even with no shared word", async () => {
    const c = await seed();
    const r = new PersonaRetriever(db, "vector", async () => unit(1));
    const hits = await r.retrieve(c.id, "ever been to japan?", 1);
    expect(hits.map((h) => h.id)).toEqual(["tokyo"]);
  });

  test("fts never calls the embedder", async () => {
    const c = await seed();
    let called = false;
    const r = new PersonaRetriever(db, "fts", async () => ((called = true), unit(0)));
    expect((await r.retrieve(c.id, "your cat", 5)).map((h) => h.id)).toEqual(["cat"]);
    expect(called).toBe(false);
  });

  test("a Voyage failure falls back to full-text and is logged", async () => {
    const c = await seed();
    const logs: string[] = [];
    const r = new PersonaRetriever(db, "hybrid", async () => { throw new Error("429"); }, (l) => logs.push(l));
    expect((await r.retrieve(c.id, "your cat", 5)).map((h) => h.id)).toEqual(["cat"]);
    expect(logs).toEqual(["retrieval: hybrid failed (Error), falling back to fts"]);
  });

  test("strategy values outside the three are refused", () => {
    expect(parseStrategy("vector")).toBe("vector");
    expect(() => parseStrategy("bm25")).toThrow(/retrieval.strategy/);
  });

  test("reply chunks lose the Instagram @mention before they reach the prompt; captions are untouched", () => {
    expect(promptText("fan: cute / juno: @user you")).toBe("fan: cute / juno: you");
    expect(promptText("fan: hi / juno: @user @user ok 🤭")).toBe("fan: hi / juno: ok 🤭");
    expect(promptText("2021-09-21 carousel: shoutout junofilm")).toBe("2021-09-21 carousel: shoutout junofilm");
  });
});
