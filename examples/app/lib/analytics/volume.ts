import { sql } from "drizzle-orm";
import { bucketStarts } from "./range";
import { bucketMs, dense, inScope, inWindow, int, rowsOf, type Query, type Series } from "./query";

export interface VolumePoint extends Record<string, number> {
  fanMessages: number;
  aiReplies: number;
  humanReplies: number;
  activeConversations: number;
}
export interface Volume {
  totals: VolumePoint;
  series: Series<VolumePoint>[];
}

const ZERO: VolumePoint = { fanMessages: 0, aiReplies: 0, humanReplies: 0, activeConversations: 0 };

// AI replies are sent messages only: superseded and suggested drafts never reached the fan.
const counts = sql`
  count(*) filter (where m.sender = 'fan') as fan,
  count(*) filter (where m.sender = 'ai' and m.status = 'sent' and not m.suggested) as ai,
  count(*) filter (where m.sender in ('creator', 'admin') and m.status = 'sent') as human,
  count(distinct m.conversation_id) as active`;

type Row = { t?: number; fan: unknown; ai: unknown; human: unknown; active: unknown };
const point = (r: Row): VolumePoint => ({
  fanMessages: int(r.fan),
  aiReplies: int(r.ai),
  humanReplies: int(r.human),
  activeConversations: int(r.active),
});

export async function getVolume(q: Query): Promise<Volume> {
  const from = sql`from messages m join conversations c on c.id = m.conversation_id
    where ${inScope(q)} and ${inWindow(sql`m.created_at`, q)}`;
  const [total] = await rowsOf<Row>(sql`select ${counts} ${from}`);
  const byBucket = await rowsOf<Row & { t: number }>(
    sql`select ${bucketMs(sql`m.created_at`, q.bucket)} as t, ${counts} ${from} group by 1`,
  );
  const series = dense(
    bucketStarts(q.from, q.to, q.bucket),
    byBucket.map((r) => ({ t: Number(r.t), ...point(r) })),
    ZERO,
  );
  return { totals: point(total), series };
}
