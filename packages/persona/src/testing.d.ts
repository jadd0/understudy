// Types for @jadd0/understudy-persona/testing: fakes for tests that must not reach the network.
import type { Claude } from "./index";

export interface FetchLogEntry {
  url: string;
  init?: RequestInit;
}

/** A fetch that serves the recorded Instagram fixtures and throws on any URL without one. */
export function fixtureFetch(options?: {
  routes?: Record<string, string>;
  dir?: string;
  overrides?: Record<string, (url: string, init?: RequestInit) => Promise<Response>>;
  log?: FetchLogEntry[];
}): typeof fetch;

export interface CardCall {
  model: string;
  system?: string;
  prompt: string;
  maxTokens: number;
}

/** A Claude that drafts a well-formed card from the ids its prompt lists. */
export function fakeCardClaude(options?: { calls?: CardCall[] }): Claude;

/** Writes a small zip file; options can write the shapes the reader refuses. */
export function writeZip(
  file: string,
  entries: {
    name: string;
    data: string | Buffer;
    method?: number;
    encrypted?: boolean;
    badCrc?: boolean;
    descriptor?: boolean;
    declaredSize?: number;
  }[],
  defaults?: { zip64Marker?: boolean; method?: number; encrypted?: boolean; badCrc?: boolean; descriptor?: boolean; multiDisk?: boolean },
): void;
