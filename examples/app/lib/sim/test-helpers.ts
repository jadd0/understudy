// Fixtures for the simulator's tests. Not imported by product code.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { config } from "@/db/schema";
import { ENGINE_CONFIG, RETRIEVAL_CONFIG, SIM_CONFIG, WALLET_CONFIG } from "@/db/seed";
import { makeAdmin } from "@/lib/conversations/test-helpers";
import { makeCreator, makeItem, makePersona, rig, type Rig, FakeGenerator } from "@jadd0/understudy-engine/testing";
import type { SimDeps } from "./deps";
import type { Beat, Persona } from "./persona";
import { FakeSimStripe } from "./stripe";

/** Engine, wallet, retrieval and sim config rows in one statement (the per-key loop costs a round trip each). */
export async function setSimConfig(over: Record<string, unknown> = {}) {
  const rows = Object.entries({ ...WALLET_CONFIG, ...RETRIEVAL_CONFIG, "retrieval.strategy": "fts", ...ENGINE_CONFIG, ...SIM_CONFIG, "sim.enabled": true, "sim.welcome_credit": false, ...over }).map(([key, value]) => ({ key, value }));
  await db
    .insert(config)
    .values(rows)
    .onConflictDoUpdate({ target: [config.key, config.creatorId], set: { value: sql`excluded.value` } });
}

/** A creator with a published card and two items, the creator and admin seats, and nothing else. */
export async function simWorld(over: Record<string, unknown> = {}, neverList: string[] = []) {
  await setSimConfig(over);
  const creator = await makeCreator();
  const card = await makePersona(creator.id, "You are Juno. lowercase, warm.", neverList);
  const itemA = await makeItem(creator.id, { title: "Golden hour", priceCents: 999, teaser: "rooftop" });
  const itemB = await makeItem(creator.id, { title: "Lazy Sunday", priceCents: 1499, teaser: "coffee" });
  const admin = await makeAdmin();
  const seats = { creator: { id: creator.userId, role: "creator" as const }, admin: { id: admin.id, role: "admin" as const } };
  return { creator, card, itemA, itemB, admin, seats };
}

export interface SimRig {
  deps: SimDeps;
  engine: Rig;
  sim: FakeGenerator;
  stripe: FakeSimStripe;
  sleeps: number[];
  onSleep: { current: ((ms: number) => Promise<void>) | null };
}

/** Engine on fakes (scripted Jev, canned Claude replies), the sim fan's model on a fake that answers a JSON action. */
export function simRig(opts: { engine?: Parameters<typeof rig>[0]; sim?: ConstructorParameters<typeof FakeGenerator>[0] } = {}): SimRig {
  const engine = rig(opts.engine);
  const sim = new FakeGenerator(opts.sim ?? { replies: [JSON.stringify({ action: "send_message", text: "hey juno how was your day" })] });
  const stripe = new FakeSimStripe();
  const sleeps: number[] = [];
  const onSleep: SimRig["onSleep"] = { current: null };
  return {
    engine,
    sim,
    stripe,
    sleeps,
    onSleep,
    deps: {
      engine: engine.deps,
      generator: sim,
      stripe,
      sleep: async (ms) => {
        sleeps.push(ms);
        await onSleep.current?.(ms);
      },
      now: () => new Date(),
    },
  };
}

export const say = (text: string) => JSON.stringify({ action: "send_message", text });

const REPLY = { queue: "none" as const, route: "reply" as const };

/** A persona built in a test. Beats default to what a calm free-play chat expects. */
export function testPersona(beats: Beat[], over: Partial<Persona> = {}): Persona {
  const slug = over.slug ?? `t-${randomUUID().slice(0, 6)}`;
  return {
    slug,
    name: "Tester",
    lang: "en",
    voice: "plain",
    goal: "test",
    spend_cents: 0,
    free_play: true,
    weight: 1,
    variants: [{ name: "Tess", age: 30, city: "Reno" }],
    exercises: ["route_reply"],
    goals: ["test"],
    brief: `${slug}.brief.md`,
    beats,
    briefText: "# test\nYou are Tess.",
    file: `${slug}.json`,
    ...over,
  };
}

export const freeBeat = (topic = "small talk", expect: Extract<Beat, { kind: "free" }>["expect"] = REPLY): Beat => ({ kind: "free", topic, expect });
