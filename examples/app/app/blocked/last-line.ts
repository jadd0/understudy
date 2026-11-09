import { sql } from "drizzle-orm";
import { db } from "@/db/client";

/**
 * The one line she wrote when a threat got this account flagged, or null. The flagging commit stamps the account and
 * the line with one database timestamp, so the line is the AI message at or after the flag; an account flagged for
 * any other reason, or a threat whose line never passed a check, has none.
 */
export async function threatLine(userId: string): Promise<string | null> {
  const { rows } = await db.execute(sql`
    select m.body from users u
      join conversations c on c.fan_id = u.id
      join messages m on m.conversation_id = c.id
    where u.id = ${userId} and u.flag_reason = 'threat' and u.flagged_at is not null
      and m.sender = 'ai' and m.status = 'sent' and m.created_at >= u.flagged_at
    order by m.created_at desc, m.id desc
    limit 1`);
  return (rows[0] as { body: string } | undefined)?.body ?? null;
}
