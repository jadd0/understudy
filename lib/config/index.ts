import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { config } from "@/db/schema";

export class ConfigMissing extends Error {
  constructor(public readonly key: string) {
    super(`config row missing: ${key}`);
    this.name = "ConfigMissing";
  }
}

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
