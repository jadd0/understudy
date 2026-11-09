import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { MessageRefused, TakeoverRefused, type Chatter, type HumanActor } from "@understudy/engine";
import type { Bus } from "./bus";
import type { ServerStore } from "./host";

export interface ServerOptions {
  chatter: Chatter;
  /** The one key every route but `/health` needs, sent as `authorization: Bearer <key>`. */
  apiKey: string;
  bus: Bus;
  store: ServerStore;
  /** Fastify's logger; off by default. Errors are logged by class, never by message. */
  logger?: boolean;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Resolves when every turn started by a POST has finished. */
    idle(): Promise<void>;
  }
}

const uuid = { type: "string", format: "uuid" } as const;
const sideProps = { actorId: uuid, side: { enum: ["creator", "ts"] }, creatorId: uuid } as const;

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Compares two secrets without leaking where they differ or how long they are. */
export function keyMatches(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

function actorOf(b: { actorId: string; side: "creator" | "ts"; creatorId?: string }): HumanActor | null {
  if (b.side === "ts") return { id: b.actorId, side: "ts" };
  return b.creatorId ? { id: b.actorId, side: "creator", creatorId: b.creatorId } : null;
}

/** Builds the HTTP surface over an engine. It does not listen: the caller does, or injects requests. */
export function buildServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  const turns = new Set<Promise<void>>();
  const streams = new Set<() => void>();

  app.decorate("idle", async () => {
    await Promise.all([...turns]);
  });

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health") return;
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (!m || !keyMatches(m[1], opts.apiKey)) return reply.code(401).send({ code: "unauthorized" });
  });

  app.addHook("onClose", async () => {
    for (const end of [...streams]) end();
    await Promise.allSettled([...turns]);
  });

  app.get("/health", async () => ({ ok: true }));

  app.post<{ Body: { creatorId: string; fanId: string; body: string; clientMsgId: string } }>(
    "/v1/messages",
    {
      schema: {
        body: {
          type: "object",
          required: ["creatorId", "fanId", "body", "clientMsgId"],
          additionalProperties: false,
          properties: { creatorId: uuid, fanId: uuid, body: { type: "string", maxLength: 20000 }, clientMsgId: { type: "string", maxLength: 1000 } },
        },
      },
    },
    async (req, reply) => {
      const m = req.body;
      if (await opts.store.isFlagged(m.fanId)) return reply.code(403).send({ code: "restricted" });
      let handled;
      try {
        handled = await opts.chatter.handleMessage(m);
      } catch (e) {
        if (e instanceof MessageRefused) return reply.code(422).send({ code: e.code });
        throw e;
      }
      if (!handled.duplicate) {
        const turn = handled.process().catch((e) => app.log.error({ errorClass: (e as Error)?.name }, "turn failed"));
        turns.add(turn);
        void turn.finally(() => turns.delete(turn));
      }
      return reply.code(202).send({ conversationId: handled.conversationId, messageId: handled.messageId, duplicate: handled.duplicate });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/conversations/:id/events",
    { schema: { params: { type: "object", properties: { id: uuid } } } },
    (req, reply) => {
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write(": connected\n\n");
      const write = (chunk: string) => {
        if (!res.writableEnded && !res.destroyed) res.write(chunk);
      };
      const unsubscribe = opts.bus.subscribe(req.params.id, (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const heartbeat = setInterval(() => write(": heartbeat\n\n"), 15_000);
      const end = () => {
        clearInterval(heartbeat);
        unsubscribe();
        streams.delete(end);
        if (!res.writableEnded) res.end();
      };
      streams.add(end);
      req.raw.on("close", end);
    },
  );

  const humanBody = (extra: object, required: string[]) => ({
    body: { type: "object", required: ["actorId", "side", ...required], additionalProperties: false, properties: { ...sideProps, ...extra } },
    params: { type: "object", properties: { id: uuid } },
  });

  const refusal = (e: unknown, reply: { code(n: number): { send(b: unknown): unknown } }) => {
    if (e instanceof TakeoverRefused) return reply.code(e.code === "not_found" ? 404 : 409).send({ code: e.code });
    throw e;
  };

  const announceMode = async (id: string) => {
    const mode = await opts.store.modeOf(id);
    await opts.bus.emit(`conversation:${id}`, "conversation.mode", { mode });
  };

  app.post<{ Params: { id: string }; Body: { actorId: string; side: "creator" | "ts"; creatorId?: string } }>(
    "/v1/conversations/:id/takeover",
    { schema: humanBody({}, []) },
    async (req, reply) => {
      const actor = actorOf(req.body);
      if (!actor) return reply.code(400).send({ code: "creator_id_required" });
      try {
        await opts.chatter.takeOver(req.params.id, actor);
      } catch (e) {
        return refusal(e, reply);
      }
      await announceMode(req.params.id);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string }; Body: { actorId: string; side: "creator" | "ts"; creatorId?: string; body: string; clientMsgId?: string } }>(
    "/v1/conversations/:id/human-messages",
    { schema: humanBody({ body: { type: "string", minLength: 1, maxLength: 20000 }, clientMsgId: { type: "string", minLength: 8, maxLength: 64 } }, ["body"]) },
    async (req, reply) => {
      const actor = actorOf(req.body);
      if (!actor) return reply.code(400).send({ code: "creator_id_required" });
      try {
        const messageId = await opts.chatter.humanReply(req.params.id, actor, req.body.body, { clientMsgId: req.body.clientMsgId ?? null });
        return reply.code(201).send({ messageId });
      } catch (e) {
        if (e instanceof RangeError) return reply.code(422).send({ code: "bad_body" });
        return refusal(e, reply);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/conversations/:id/hand-back",
    { schema: { params: { type: "object", properties: { id: uuid } } } },
    async (req, reply) => {
      if ((await opts.store.modeOf(req.params.id)) === null) return reply.code(404).send({ code: "not_found" });
      await opts.chatter.handBack(req.params.id);
      await announceMode(req.params.id);
      return reply.code(204).send();
    },
  );

  return app;
}
