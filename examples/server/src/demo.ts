import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readConfigFile, type ConfigFile } from "./config";
import { connect } from "./db";
import { readEnv } from "./env";
import { startServer } from "./main";
import { SERVER_DIR, seedPersona } from "./seed";

export interface DemoOptions {
  /** Scripted providers (the in-process server only). */
  fake: boolean;
  /** Talk to a server already running there instead of starting one; needs `UNDERSTUDY_API_KEY`. */
  url?: string;
  /** Take the conversation over after this many fan lines. */
  takeoverAfter: number;
  /** Shorter typing delays, so a run takes seconds. */
  fast: boolean;
  out: (line: string) => void;
  env?: Record<string, string | undefined>;
}

export interface DemoResult {
  fanLines: number;
  /** Bubbles received per fan line, in order. */
  repliesPerLine: number[];
}

interface Streamed {
  event: string;
  data: Record<string, unknown>;
  at: number;
}

const FAST_ROWS = { "engine.debounce_ms": 50, "engine.typing_cps": 400, "delivery.bubble_gap_ms_min": 20, "delivery.bubble_gap_ms_max": 60, "engine.typing_max_ms": 300 };

/** Reads an SSE response into `events` until it is cancelled. */
async function readStream(res: Response, events: Streamed[]): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (event && data) events.push({ event, data: JSON.parse(data) as Record<string, unknown>, at: Date.now() });
    }
  }
}

/** Plays `demo-script.txt` as one fan against Juno: replies, an offer, a takeover, her own message, a hand-back. */
export async function runDemo(opts: DemoOptions): Promise<DemoResult> {
  const env = opts.env ?? process.env;
  const out = opts.out;
  const lines = readFileSync(path.join(SERVER_DIR, "demo-script.txt"), "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  const rawConfig = readConfigFile(path.join(SERVER_DIR, "config.json"));
  const config: ConfigFile = opts.fast ? { ...rawConfig, rows: { ...rawConfig.rows, ...FAST_ROWS } } : rawConfig;
  const quietMs = opts.fast ? 700 : Number(config.rows["delivery.bubble_gap_ms_max"]) + 1500;

  let apiKey = env.UNDERSTUDY_API_KEY ?? "";
  let base = opts.url ?? "";
  let stop: () => Promise<void> = async () => {};
  if (!opts.url) {
    apiKey = apiKey || randomUUID();
    const serverEnv = readEnv({ ...env, UNDERSTUDY_API_KEY: apiKey, PORT: "0", WEBHOOK_URL: undefined }, { fake: opts.fake });
    const { db, end } = connect(serverEnv.databaseUrl);
    await seedPersona(db, config.creatorId);
    await end();
    const running = await startServer({ env: serverEnv, fake: opts.fake, config, listen: true });
    base = running.url!;
    stop = running.close;
    out(`server: ${base} (${opts.fake ? "scripted providers" : "live providers"})`);
  }
  if (!apiKey) throw new Error("UNDERSTUDY_API_KEY is not set");

  const call = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };

  const fanId = randomUUID();
  const creatorId = config.creatorId;
  const actorId = randomUUID();
  const events: Streamed[] = [];
  const abort = new AbortController();
  let conversationId = "";
  let seen = 0;
  const repliesPerLine: number[] = [];

  /** Waits for at least one bubble, then for a quiet spell; prints each bubble with the wait before it. */
  const collect = async (since: number, expectReply: boolean): Promise<number> => {
    const deadline = Date.now() + (expectReply ? 60_000 : quietMs * 2);
    let last = since;
    let bubbles = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 25));
      for (; seen < events.length; seen++) {
        const e = events[seen];
        if (e.event === "message") {
          bubbles++;
          const offer = e.data.offer as { title: string; priceCents: number } | undefined;
          out(`  ${String(e.data.sender).padEnd(7)}[+${((e.at - last) / 1000).toFixed(1)}s] ${String(e.data.body).replace(/\n/g, " / ")}`);
          if (offer) out(`          offer: ${offer.title} at ${(offer.priceCents / 100).toFixed(2)}`);
          last = e.at;
        } else if (e.event === "mode") {
          out(`  mode -> ${String(e.data.mode)}`);
          last = e.at;
        }
      }
      const settled = bubbles > 0 && Date.now() - last > quietMs;
      if (settled || (!expectReply && Date.now() - since > quietMs) || Date.now() > deadline) return bubbles;
    }
  };

  const send = async (text: string) => {
    out(`fan> ${text}`);
    const sentAt = Date.now();
    const res = await call("POST", "/v1/messages", { creatorId, fanId, body: text, clientMsgId: randomUUID() });
    if (res.status !== 202) throw new Error(`send refused: ${res.status}`);
    if (!conversationId) {
      conversationId = String(res.json.conversationId);
      const stream = await fetch(`${base}/v1/conversations/${conversationId}/events`, { headers: { authorization: `Bearer ${apiKey}` }, signal: abort.signal });
      void readStream(stream, events).catch(() => undefined);
    }
    return sentAt;
  };

  try {
    const takeoverAfter = Math.min(opts.takeoverAfter, lines.length);
    for (let i = 0; i < lines.length; i++) {
      repliesPerLine.push(await collect(await send(lines[i]), true));
      if (i + 1 === takeoverAfter) {
        out("== TAKEOVER: Juno steps in ==");
        const t = await call("POST", `/v1/conversations/${conversationId}/takeover`, { actorId, side: "creator", creatorId });
        if (t.status !== 204) throw new Error(`takeover refused: ${t.status}`);
        await collect(Date.now(), false);
        const h = await call("POST", `/v1/conversations/${conversationId}/human-messages`, { actorId, side: "creator", creatorId, body: "hey, it's me, juno. biscuit says hi xx" });
        if (h.status !== 201) throw new Error(`human message refused: ${h.status}`);
        await collect(Date.now(), true);
        out("== HAND-BACK: the AI answers again ==");
        const b = await call("POST", `/v1/conversations/${conversationId}/hand-back`);
        if (b.status !== 204) throw new Error(`hand-back refused: ${b.status}`);
        await collect(Date.now(), false);
      }
    }
    out(`done: ${lines.length} fan lines, ${repliesPerLine.reduce((a, b) => a + b, 0)} bubbles`);
    return { fanLines: lines.length, repliesPerLine };
  } finally {
    abort.abort();
    await stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(name);
  const value = (name: string) => args[args.indexOf(name) + 1];
  runDemo({
    fake: flag("--fake"),
    url: flag("--url") ? value("--url") : undefined,
    takeoverAfter: flag("--takeover-after") ? Number(value("--takeover-after")) : 6,
    // Scripted providers answer at once, so the delays are shortened too; --realtime keeps the configured pace.
    fast: flag("--fast") || (flag("--fake") && !flag("--realtime")),
    out: (l) => console.log(l),
  })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("demo failed:", (e as { code?: string; name?: string }).code ?? (e as Error).name, (e as Error).name === "Error" ? (e as Error).message : "");
      process.exit(1);
    });
}
