// Fakes and a world builder for the engine's tests. Not imported by product code.
import { db } from "@/db/client";
import { creators } from "@/db/schema";
import { eq } from "drizzle-orm";
import { FakeDecider, type Scripted } from "./fake/decider";
import { FakeGenerator, type FakeGeneratorOptions } from "./fake/generator";
import { dbConfigPort } from "@/lib/config";
import { dbHost } from "@/lib/host/engine-host";
import { FtsRetriever } from "@understudy/providers";
import type { Events } from "./ports/events";
import { createChatter, type Chatter } from "./chatter";
import type { Deps, EngineCtx } from "./ctx";
import { addMessage, makeConversation, makeCreator, makeFan, makeItem, makePersona, setEngineConfig } from "./test-db";

const NO = { value: "no", probabilities: { yes: 0.02, no: 0.98 } };

export const YES = { value: "yes", probabilities: { yes: 0.95, no: 0.05 } };

/** A calm fan and a clean draft: every question answered the harmless way. Override per test. */
export function script(over: Record<string, Scripted> = {}): Record<string, Scripted> {
  return {
    intent: { value: "smalltalk", probabilities: { smalltalk: 0.9 } },
    explicitness: (state) => (typeof state === "object" && state && "draft" in state ? "flirty" : "none"),
    minor: NO,
    self_harm: NO,
    threat: NO,
    location_offplatform: NO,
    payment_dispute: NO,
    hardship: NO,
    thread: "same_topic",
    pitch_fit: YES,
    reasks: "no",
    offer_response: "na",
    offer_pick: "o1",
    on_persona: "yes",
    offplatform_or_meetup: "no",
    is_refusal: "no",
    admits_ai: "no",
    promises_price_or_free: "no",
    leads_to_offer: "yes",
    ...over,
  };
}

export function isMemoryCall(input: { system: { cached: string } }) {
  return input.system.cached.startsWith("Extract facts");
}

export interface Rig {
  deps: Deps;
  /** The engine context over the test database, for tests that call engine functions directly. */
  ctx: EngineCtx;
  /** The same wiring as `createChatter` gives a host. */
  chatter: Chatter;
  decider: FakeDecider;
  generator: FakeGenerator;
  sleeps: number[];
  emitted: { channel: string; event: string; payload: Record<string, unknown> }[];
  /** Runs inside every clock.sleep (the debounce), before it returns. */
  onSleep: { current: ((ms: number) => Promise<void>) | null };
}

export function rig(opts: {
  script?: Record<string, Scripted>;
  decider?: ConstructorParameters<typeof FakeDecider>[0];
  replies?: FakeGeneratorOptions["replies"];
  generator?: FakeGeneratorOptions;
} = {}): Rig {
  const sleeps: number[] = [];
  const emitted: Rig["emitted"] = [];
  const onSleep: Rig["onSleep"] = { current: null };
  const skew = { ms: 0 };
  const decider = new FakeDecider({ ...opts.decider, script: script(opts.script) });
  const memoryReply = "{}";
  const replies = opts.replies ?? ["hey you, how was your day"];
  const generator: FakeGenerator = new FakeGenerator({
    ...opts.generator,
    replies: [
      (input): string => {
        if (isMemoryCall(input)) return memoryReply;
        // The n-th non-memory call takes the n-th scripted reply; the last repeats.
        const n: number = generator.calls.filter((c) => !isMemoryCall(c)).length;
        const r = replies[Math.min(n - 1, replies.length - 1)];
        return typeof r === "function" ? r(input) : r;
      },
    ],
  });
  const events: Events = {
    async emit(channel, event, payload) {
      emitted.push({ channel, event, payload });
    },
  };
  const deps: Deps = {
    decider,
    generator,
    retriever: new FtsRetriever(db),
    events,
    clock: {
      // Sleeping advances the injected clock, so the turn budget sees the time the debounce "spent".
      now: () => Date.now() + skew.ms,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        skew.ms += ms;
        await onSleep.current?.(ms);
      },
    },
  };
  return {
    deps,
    ctx: { db, config: dbConfigPort, host: dbHost, deps },
    chatter: createChatter({ db, config: dbConfigPort, host: dbHost, deps }),
    decider,
    generator,
    sleeps,
    emitted,
    onSleep,
  };
}

/** A creator with a card and two items, one fan, and one conversation holding a single unanswered fan message. */
export async function world(over: Record<string, unknown> = {}, text = "hey, how are you?") {
  await setEngineConfig(over);
  const creator = await makeCreator();
  const fan = await makeFan();
  const conv = await makeConversation(creator.id, fan.id);
  const card = await makePersona(creator.id, "You are Juno. Lowercase, warm, playful.", ["my ex"]);
  const itemA = await makeItem(creator.id, { title: "Golden hour", priceCents: 1777, teaser: "rooftop sunset" });
  const itemB = await makeItem(creator.id, { title: "Lazy Sunday", priceCents: 2888, teaser: "coffee and sunlight" });
  const first = await addMessage(conv.id, "fan", text, { ageSeconds: 5 });
  return { creator, fan, conv, card, itemA, itemB, first };
}

export async function setCreatorAi(creatorId: string, aiEnabled: boolean) {
  await db.update(creators).set({ aiEnabled }).where(eq(creators.id, creatorId));
}

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
