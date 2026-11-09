import { readFileSync } from "node:fs";
import type { ConfigPort, ConfigRow } from "@understudy/engine";

export interface ConfigFile {
  /** The one creator this server speaks for. */
  creatorId: string;
  rows: Record<string, unknown>;
}

export function readConfigFile(file: string): ConfigFile {
  return JSON.parse(readFileSync(file, "utf8")) as ConfigFile;
}

/**
 * The engine's settings from a JSON file instead of a table: platform rows only, so a creator never overrides a
 * value. `file` is a path or an already parsed config, which tests use to shorten the delays.
 */
export function jsonConfigPort(file: string | ConfigFile): ConfigPort {
  const { rows } = typeof file === "string" ? readConfigFile(file) : file;
  return {
    async rows(q): Promise<ConfigRow[]> {
      return Object.entries(rows)
        .filter(([key]) => q.keys.includes(key) || q.prefixes.some((p) => key.startsWith(p)))
        .map(([key, value]) => ({ key, value, creatorId: null }));
    },
  };
}
