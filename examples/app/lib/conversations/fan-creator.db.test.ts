import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { addMessage, makeConversation, makeCreator, makeFan } from "./test-helpers";
import { makePersona } from "@jadd0/understudy-engine/testing";
import { creatorByHandle, fanCreator } from "./read";

const published = async () => {
  const c = await makeCreator();
  await makePersona(c.id);
  return c;
};

/** The first published creator by handle, asked of the database directly so the test does not lean on `fanCreator`. */
async function firstPublishedHandle() {
  const r = await db.execute(
    sql`select c.handle from creators c where exists (select 1 from persona_cards p where p.creator_id = c.id and p.published_at is not null) order by c.handle limit 1`,
  );
  return (r.rows[0] as { handle: string }).handle;
}

describe("fanCreator", () => {
  test("a handle names its creator in any letter case, and an unknown one names nobody", async () => {
    const c = await published();
    const fan = await makeFan();
    expect((await fanCreator(fan.id, c.handle))?.id).toBe(c.id);
    expect(c.handle).not.toBe(c.handle.toUpperCase());
    expect((await fanCreator(fan.id, c.handle.toUpperCase()))?.id).toBe(c.id);
    expect((await creatorByHandle(c.handle.toUpperCase()))?.id).toBe(c.id);
    for (const bad of ["no-such-handle", "", "'; drop table creators; --"]) expect(await fanCreator(fan.id, bad)).toBeNull();
  });

  test("a creator without a published persona card is nobody, by handle or by default", async () => {
    const fan = await makeFan();
    const unpublished = await makeCreator();
    expect(await fanCreator(fan.id, unpublished.handle)).toBeNull();
    // a draft card (published_at null) is still not a voice to answer in
    await db.execute(sql`insert into persona_cards (creator_id, version, body) values (${unpublished.id}, 1, 'draft')`);
    expect(await fanCreator(fan.id, unpublished.handle)).toBeNull();
    // even with a conversation of her own the unpublished creator is skipped
    await makeConversation(unpublished.id, fan.id);
    const open = await fanCreator(fan.id, null);
    expect(open?.id).not.toBe(unpublished.id);
    // once her card is published she is reachable
    await db.execute(sql`update persona_cards set published_at = now() where creator_id = ${unpublished.id}`);
    expect((await fanCreator(fan.id, unpublished.handle))?.id).toBe(unpublished.id);
    expect((await fanCreator(fan.id, null))?.id).toBe(unpublished.id);
  });

  test("with no handle it is the creator of the fan's most recently active conversation", async () => {
    const [x, y] = [await published(), await published()];
    const fan = await makeFan();
    const other = await makeFan();
    // the more recent thread belongs to the creator whose handle sorts later, so the first-by-handle fallback cannot pass it
    const [early, late] = x.handle < y.handle ? [x, y] : [y, x];
    const earlyConv = await makeConversation(early.id, fan.id);
    const lateConv = await makeConversation(late.id, fan.id);
    await addMessage(earlyConv.id, "fan", "older", { ageSeconds: 500 });
    await addMessage(lateConv.id, "fan", "newer", { ageSeconds: 50 });
    expect((await fanCreator(fan.id, null))?.id).toBe(late.id);
    expect((await fanCreator(fan.id))?.id).toBe(late.id);
    // a message in the other thread moves the default to it
    await addMessage(earlyConv.id, "fan", "newest", { ageSeconds: 1 });
    expect((await fanCreator(fan.id, null))?.id).toBe(early.id);
    // another fan's busier thread does not count
    const theirs = await makeConversation(late.id, other.id);
    await addMessage(theirs.id, "fan", "hi", { ageSeconds: 0 });
    expect((await fanCreator(fan.id, null))?.id).toBe(early.id);
    // naming a handle still wins over recency
    expect((await fanCreator(fan.id, late.handle))?.id).toBe(late.id);
  });

  test("a fan with no conversation gets the first published creator by handle", async () => {
    await published();
    const fan = await makeFan();
    expect((await fanCreator(fan.id, null))?.handle).toBe(await firstPublishedHandle());
  });
});
