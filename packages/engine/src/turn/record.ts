import { and, eq, inArray, sql } from "drizzle-orm";
import type { EngineTx } from "../ports/db";
import { messages } from "../db/schema";
import type { TurnRecord } from "./plan";

export function turnValues(conversationId: string, rec: TurnRecord, outcome: string) {
  return {
    conversationId,
    inboundIds: rec.inboundIds,
    route: rec.route,
    jevIn: rec.jevIn,
    jevOut: rec.jevOut,
    draft: rec.draft,
    outcome,
    personaVersion: rec.personaVersion,
    models: rec.models,
    tokens: rec.tokens,
    costMicros: rec.costMicros,
    msJevIn: rec.msJevIn,
    msGen: rec.msGen,
    msJevOut: rec.msJevOut,
    attempts: rec.attempts,
  };
}

/** The body of her last bubble the fan can see or will see (AI or a human on her side), or null. */
export async function lastHerBody(tx: EngineTx, conversationId: string): Promise<string | null> {
  const [row] = await tx
    .select({ body: messages.body })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        inArray(messages.sender, ["ai", "creator", "admin"]),
        eq(messages.status, "sent"),
      ),
    )
    .orderBy(sql`${messages.sortAt} desc`, sql`${messages.id} desc`)
    .limit(1);
  return row?.body ?? null;
}

export async function elapsedSinceFirstInbound(tx: EngineTx, inboundIds: string[]): Promise<number> {
  if (inboundIds.length === 0) return 0;
  const [row] = await tx
    .select({ ms: sql<number>`coalesce(extract(epoch from now() - min(${messages.createdAt})) * 1000, 0)::float8` })
    .from(messages)
    .where(inArray(messages.id, inboundIds));
  return Number(row.ms);
}

/** `ms_total` for a turn that did not commit a reply: time since the first message it was handling. */
export async function msTotalOf(tx: EngineTx, inboundIds: string[]): Promise<number | null> {
  return inboundIds.length === 0 ? null : Math.round(await elapsedSinceFirstInbound(tx, inboundIds));
}
