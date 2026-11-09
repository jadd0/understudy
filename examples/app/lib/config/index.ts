import { and, eq, inArray, isNull, like, or } from "drizzle-orm";
import { db } from "@/db/client";
import { config } from "@/db/schema";
import { ConfigMissing, type ConfigPort } from "@understudy/engine";

export { ConfigMissing };

/** A creator's row wins, then the platform row (creator_id null). No code default: a missing row fails closed. */
export async function getConfig<T = unknown>(key: string, creatorId?: string): Promise<T> {
  if (creatorId) {
    const [own] = await db
      .select({ value: config.value })
      .from(config)
      .where(and(eq(config.key, key), eq(config.creatorId, creatorId)));
    if (own) return own.value as T;
  }
  const [platform] = await db
    .select({ value: config.value })
    .from(config)
    .where(and(eq(config.key, key), isNull(config.creatorId)));
  if (platform) return platform.value as T;
  throw new ConfigMissing(key);
}

/** The engine's view of the `config` table: platform rows, plus the asked creator's rows, for the keys and prefixes it names. */
export const dbConfigPort: ConfigPort = {
  async rows({ keys, prefixes, creatorId }) {
    const match = or(...(keys.length > 0 ? [inArray(config.key, keys)] : []), ...prefixes.map((p) => like(config.key, `${p}%`)));
    if (!match) return [];
    return db
      .select({ key: config.key, value: config.value, creatorId: config.creatorId })
      .from(config)
      .where(and(match, creatorId ? or(isNull(config.creatorId), eq(config.creatorId, creatorId)) : isNull(config.creatorId)));
  },
};
