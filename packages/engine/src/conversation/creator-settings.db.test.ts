import { describe, expect, test } from "vitest";
import { db } from "@/db/client";
import { creatorAi, setCreatorAi } from "./creator-settings";
import { acquireLease, releaseLease } from "./lease";
import { makeConversation, makeCreator, makeFan, makePersona, setEngineConfig } from "../testing/db";
import { rig } from "../testing/harness";

async function twoCreators() {
  await setEngineConfig();
  const a = await makeCreator();
  const b = await makeCreator();
  await makePersona(a.id);
  await makePersona(b.id);
  const fan = await makeFan();
  const fan2 = await makeFan();
  return {
    a,
    b,
    convA1: await makeConversation(a.id, fan.id),
    convA2: await makeConversation(a.id, fan2.id),
    convB: await makeConversation(b.id, fan.id),
  };
}

describe("the per-creator AI switch", () => {
  test("no row means the AI is on", async () => {
    const w = await twoCreators();
    const r = rig();
    expect(await creatorAi(db, w.a.id)).toBe(true);
    expect(await r.chatter.creatorAi(w.a.id)).toBe(true);
    const lease = await acquireLease(r.ctx, w.convA1.id, 30_000);
    expect(lease).not.toBeNull();
    await releaseLease(r.ctx, lease!);
  });

  test("setCreatorAi(false) stops the lease for every conversation of that creator and no other", async () => {
    const w = await twoCreators();
    const r = rig();
    await r.chatter.setCreatorAi(w.a.id, false);
    expect(await r.chatter.creatorAi(w.a.id)).toBe(false);
    expect(await acquireLease(r.ctx, w.convA1.id, 30_000)).toBeNull();
    expect(await acquireLease(r.ctx, w.convA2.id, 30_000)).toBeNull();
    const other = await acquireLease(r.ctx, w.convB.id, 30_000);
    expect(other).not.toBeNull();
    await releaseLease(r.ctx, other!);

    await r.chatter.setCreatorAi(w.a.id, true);
    const back = await acquireLease(r.ctx, w.convA1.id, 30_000);
    expect(back).not.toBeNull();
    await releaseLease(r.ctx, back!);
  });

  test("setCreatorAi is idempotent", async () => {
    const w = await twoCreators();
    await setCreatorAi(db, w.a.id, false);
    await setCreatorAi(db, w.a.id, false);
    expect(await creatorAi(db, w.a.id)).toBe(false);
    await setCreatorAi(db, w.a.id, true);
    await setCreatorAi(db, w.a.id, true);
    expect(await creatorAi(db, w.a.id)).toBe(true);
    const rows = await db.execute(`select count(*)::int as n from creator_settings where creator_id = '${w.a.id}'`);
    expect((rows.rows[0] as { n: number }).n).toBe(1);
  });
});
