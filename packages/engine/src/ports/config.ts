/** One `config` row as the engine reads it. `creatorId` is null for a platform row. */
export interface ConfigRow {
  key: string;
  value: unknown;
  creatorId: string | null;
}

/**
 * Where the engine's settings come from. `rows` returns the platform rows (creatorId null) for the keys and
 * prefixes asked, and, when `creatorId` is given, that creator's rows for them too. Which row wins, and which keys a
 * creator may never override, is decided by the engine, so a host cannot loosen a safety floor through this port.
 */
export interface ConfigPort {
  rows(q: { keys: string[]; prefixes: string[]; creatorId?: string }): Promise<ConfigRow[]>;
}

/** A required setting has no row. The engine fails closed on it: there is no code default. */
export class ConfigMissing extends Error {
  constructor(public readonly key: string) {
    super(`config row missing: ${key}`);
    this.name = "ConfigMissing";
  }
}
