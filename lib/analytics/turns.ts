import { sql } from "drizzle-orm";
import { inScope, inWindow, int, num, rowsOf, type Query } from "./query";

export const PAGE_SIZE = 10;

export interface TurnFilter {
  route?: string;
  outcome?: string;
  page?: number;
}
export interface TurnRow {
  id: string;
  createdAt: Date;
  conversationId: string;
  fanId: string;
  isSim: boolean;
  route: string | null;
  outcome: string | null;
  msTotal: number | null;
  costMicros: number | null;
}
export interface TurnPage {
  rows: TurnRow[];
  total: number;
  page: number;
  pages: number;
}

const ROUTES = ["reply", "offer", "hold_creator", "hard_stop", "deflect", "ai_disclosure", "none"];
export const ROUTE_FILTERS = ROUTES;

/** Paged turns in the window, newest first. A route filter of `none` selects turns that recorded no route. */
export async function listTurns(q: Query, f: TurnFilter = {}): Promise<TurnPage> {
  const route = f.route && ROUTES.includes(f.route) ? f.route : null;
  const outcome = f.outcome && /^[a-z_]{1,24}$/.test(f.outcome) ? f.outcome : null;
  const where = sql`${inScope(q)} and ${inWindow(sql`t.created_at`, q)} and coalesce(t.outcome, '') <> 'handback'
    ${route === "none" ? sql`and t.route is null` : route ? sql`and t.route = ${route}::turn_route` : sql``}
    ${outcome ? sql`and t.outcome = ${outcome}` : sql``}`;
  const [{ n }] = await rowsOf<{ n: unknown }>(sql`select count(*) as n from turns t join conversations c on c.id = t.conversation_id where ${where}`);
  const total = int(n);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.floor(f.page ?? 1) || 1), pages);
  const rows = await rowsOf<Record<string, unknown>>(sql`
    select t.id, t.created_at, t.conversation_id, c.fan_id, u.is_sim, t.route::text as route, t.outcome, t.ms_total, t.cost_micros
    from turns t join conversations c on c.id = t.conversation_id join users u on u.id = c.fan_id
    where ${where}
    order by t.created_at desc, t.id
    limit ${PAGE_SIZE} offset ${(page - 1) * PAGE_SIZE}`);
  return {
    total,
    page,
    pages,
    rows: rows.map((r) => ({
      id: r.id as string,
      createdAt: new Date(r.created_at as string),
      conversationId: r.conversation_id as string,
      fanId: r.fan_id as string,
      isSim: r.is_sim as boolean,
      route: (r.route as string | null) ?? null,
      outcome: (r.outcome as string | null) ?? null,
      msTotal: num(r.ms_total),
      costMicros: num(r.cost_micros),
    })),
  };
}

export interface TurnDetail extends TurnRow {
  inbound: { id: string; sender: string; body: string; createdAt: Date }[];
  draft: string | null;
  reply: { body: string; status: string; suggested: boolean } | null;
  jevIn: unknown;
  jevOut: unknown;
  models: unknown;
  tokens: unknown;
  attempts: number | null;
  personaVersion: number | null;
  timings: { msJevIn: number | null; msGen: number | null; msJevOut: number | null; msTotal: number | null };
  offer: { id: string; status: string; priceCents: number } | null;
  handoff: { id: string; queue: string; reason: string; status: string } | null;
}

/** One turn's full record, or null when it is outside the viewer's scope. The caller maps null to a 404. */
export async function getTurn(q: Pick<Query, "creatorIds" | "includeTs">, id: string): Promise<TurnDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [t] = await rowsOf<Record<string, unknown>>(sql`
    select t.*, t.route::text as route_text, c.fan_id, u.is_sim
    from turns t join conversations c on c.id = t.conversation_id join users u on u.id = c.fan_id
    where t.id = ${id}::uuid and ${inScope(q)}`);
  if (!t) return null;
  const inboundIds = (t.inbound_ids as string[]) ?? [];
  const inbound = inboundIds.length
    ? await rowsOf<{ id: string; sender: string; body: string; created_at: string }>(
        sql`select id, sender::text as sender, body, created_at from messages where id in (${sql.join(inboundIds.map((i) => sql`${i}::uuid`), sql`, `)}) order by created_at, id`,
      )
    : [];
  const [reply] = await rowsOf<{ body: string; status: string; suggested: boolean }>(
    sql`select body, status::text as status, suggested from messages where turn_id = ${id}::uuid and sender in ('ai') order by created_at limit 1`,
  );
  const [offer] = t.offer_id
    ? await rowsOf<{ id: string; status: string; price_cents: unknown }>(sql`select id, status::text as status, price_cents from offers where id = ${t.offer_id as string}::uuid`)
    : await rowsOf<{ id: string; status: string; price_cents: unknown }>(sql`select id, status::text as status, price_cents from offers where turn_id = ${id}::uuid limit 1`);
  const [handoff] = t.handoff_id
    ? await rowsOf<{ id: string; queue: string; reason: string; status: string }>(sql`select id, queue::text as queue, reason::text as reason, status::text as status from handoffs where id = ${t.handoff_id as string}::uuid`)
    : [];
  return {
    id: t.id as string,
    createdAt: new Date(t.created_at as string),
    conversationId: t.conversation_id as string,
    fanId: t.fan_id as string,
    isSim: t.is_sim as boolean,
    route: (t.route_text as string | null) ?? null,
    outcome: (t.outcome as string | null) ?? null,
    msTotal: num(t.ms_total),
    costMicros: num(t.cost_micros),
    inbound: inbound.map((m) => ({ id: m.id, sender: m.sender, body: m.body, createdAt: new Date(m.created_at) })),
    draft: (t.draft as string | null) ?? null,
    reply: reply ?? null,
    jevIn: t.jev_in,
    jevOut: t.jev_out,
    models: t.models,
    tokens: t.tokens,
    attempts: num(t.attempts),
    personaVersion: num(t.persona_version),
    timings: { msJevIn: num(t.ms_jev_in), msGen: num(t.ms_gen), msJevOut: num(t.ms_jev_out), msTotal: num(t.ms_total) },
    offer: offer ? { id: offer.id, status: offer.status, priceCents: int(offer.price_cents) } : null,
    handoff: handoff ?? null,
  };
}
