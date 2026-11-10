// A fan writes to a creator and the engine answers, with scripted providers and no network call.
// Needs Postgres with pgvector (`docker compose up -d`) and DATABASE_URL pointing at an empty database.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import { createUnderstudy, systemClock } from "@jadd0/understudy-engine";
import { FakeDecider, FakeGenerator } from "@jadd0/understudy-engine/fakes";
import { messages, personaCards } from "@jadd0/understudy-engine/schema";
import { FtsRetriever, noopEvents } from "@jadd0/understudy-providers";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

// The Neon driver talks WebSocket; a local Postgres is reached through the compose proxy.
neonConfig.webSocketConstructor = ws;
if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(url).hostname)) {
  neonConfig.wsProxy = (host) => `${host}:${process.env.NEON_LOCAL_PROXY_PORT ?? 4454}/v2`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
}
const pool = new Pool({ connectionString: url });
const db = drizzle(pool);

// Settings come from a file next to this one (a copy of examples/server/config.json); the delays are shortened so
// the reply arrives in a moment. A real host reads a `config` table.
const FAST = { "engine.debounce_ms": 50, "engine.typing_cps": 400, "delivery.bubble_gap_ms_min": 20, "delivery.bubble_gap_ms_max": 60, "engine.typing_max_ms": 300 };
const rows = { ...JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8")).rows, ...FAST };
const config = {
  async rows(q) {
    return Object.entries(rows)
      .filter(([key]) => q.keys.includes(key) || q.prefixes.some((p) => key.startsWith(p)))
      .map(([key, value]) => ({ key, value, creatorId: null }));
  },
};

// The host's side: this one has no wallet and no catalogue, so nothing is ever offered.
const host = {
  fanFacts: async () => ({ spentTodayCents: 0, capCents: 0, atCap: true, unlocksInWindow: 0, highValue: false }),
  capAllows: () => false,
  catalogue: { shortlist: async () => [], ownedShortlist: async () => [], ownsEverything: async () => false },
  items: async () => new Map(),
  owns: async () => new Set(),
  flagFan: async () => {},
};

// Scripted providers: calm answers to every question, and a canned reply to the fan.
const no = { value: "no", probabilities: { yes: 0.02, no: 0.98 } };
const decider = new FakeDecider({
  script: {
    intent: { value: "smalltalk", probabilities: { smalltalk: 0.9 } },
    explicitness: "none",
    minor: no,
    self_harm: no,
    threat: no,
    location_offplatform: no,
    payment_dispute: no,
    hardship: no,
    thread: "same_topic",
    pitch_fit: { value: "yes", probabilities: { yes: 0.95, no: 0.05 } },
    reasks: "no",
    offer_response: "na",
    on_persona: "yes",
    offplatform_or_meetup: "no",
    is_refusal: "no",
    admits_ai: "no",
    promises_price_or_free: "no",
    leads_to_offer: "no",
  },
});
const generator = new FakeGenerator({
  replies: [(input) => (input.system.cached.startsWith("Extract facts") ? "{}" : "hey! long day but better now you're here")],
});

const understudy = createUnderstudy({
  db,
  config,
  host,
  deps: { decider, generator, retriever: new FtsRetriever(db), events: noopEvents, clock: systemClock },
});

await understudy.migrate();

const creatorId = randomUUID();
const fanId = randomUUID();
await db.insert(personaCards).values({ creatorId, version: 1, body: "Warm, quick, a little teasing.", publishedAt: new Date() });

const { conversationId, process: answer } = await understudy.handleMessage({ creatorId, fanId, body: "hey, how was your day?", clientMsgId: randomUUID() });
await answer();

const answers = await db.select({ body: messages.body, sender: messages.sender }).from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt));
const ai = answers.filter((m) => m.sender === "ai");
for (const m of ai) console.log(`reply: ${m.body}`);
await pool.end();
if (ai.length === 0) process.exit(1);
