import type { ConfigPort } from "@understudy/engine";

/**
 * The gateway key for a creator, or null when there is none. A creator id of `undefined` is a call that belongs to no
 * creator (a script, the fan simulator): it uses the platform key.
 */
export type GatewayKeyResolver = (creatorId: string | undefined) => Promise<string | null>;

/** The config row that names the environment variable holding a gateway key. */
export const GATEWAY_KEY_ROW = "gateway.key_env";

/**
 * Keys stay out of the database: the `gateway.key_env` row names an environment variable and the key is read from
 * `env`. The creator's row wins over the platform row, so each creator can have a tenant of their own on the gateway.
 * A row that names a variable with no value is no key (null), never a request with an empty bearer and never a
 * silent fall back to the platform's key: a creator with a tenant of their own must not spend the platform's budget.
 */
export function envKeyResolver(config: ConfigPort, env: Record<string, string | undefined>): GatewayKeyResolver {
  return async (creatorId) => {
    const rows = await config.rows({ keys: [GATEWAY_KEY_ROW], prefixes: [], creatorId });
    const matching = rows.filter((r) => r.key === GATEWAY_KEY_ROW);
    const row = (creatorId ? matching.find((r) => r.creatorId === creatorId) : undefined) ?? matching.find((r) => r.creatorId === null);
    if (!row || typeof row.value !== "string" || row.value === "") return null;
    const key = env[row.value];
    return key && key.trim() !== "" ? key : null;
  };
}
