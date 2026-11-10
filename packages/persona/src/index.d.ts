// Types for @understudy/persona. Hand-written: the package ships plain ES modules with no build step.

/** Token usage as the model adapters report it. */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

/** A Claude adapter: `createClaude()` returns one, tests pass a fake with the same shape. */
export interface Claude {
  complete(args: { model: string; system?: string; prompt: string; maxTokens: number }): Promise<{
    text: string;
    model: string;
    stopReason: string | null;
    usage: Usage;
  }>;
}

export interface JevQuestion {
  key: string;
  prompt: string;
  options: { key: string; label: string }[];
}

/** A Jev adapter: `createJev()` returns one. */
export interface Jev {
  ask(args: { model: string; state: unknown; questions: JevQuestion[] }): Promise<{
    answers: { key: string; value: string; confidence: number; probabilities?: Record<string, number> }[];
    model: string;
    usage: Usage;
  }>;
}

export interface AdapterOptions {
  fetch?: typeof fetch;
  apiKey?: string;
  backoffMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Builds the Claude adapter; throws a ClaudeError with code `not_configured` without a key. */
export function createClaude(options?: AdapterOptions): Claude;
/** Builds the Jev adapter; throws a JevError with code `not_configured` without a key. */
export function createJev(options?: AdapterOptions): Jev;

/** Running token total across the model calls of one run; throws once the cap is passed. */
export class TokenBudget {
  constructor(cap?: number);
  cap: number;
  used: number;
  claudeInput: number;
  claudeOutput: number;
  jevInput: number;
  calls: number;
  addClaude(usage: Usage): void;
  addJev(usage: Usage): void;
}

export interface SynthOptions {
  model: string;
  /** Path to the creator brief the generator reads. */
  briefPath: string;
  outDir: string;
  seed: string;
  budget: TokenBudget;
  concurrency: number;
  claude: Claude;
}
/** Generates the raw records of the synthetic creators. */
export function synth(options: SynthOptions): Promise<{ posts: number; tokens: number }>;

export interface NormaliseOptions {
  rawDir: string;
  outDir: string;
  creator: string;
}
export interface NormaliseResult {
  captions: unknown[];
  replies: unknown[];
  profile: Record<string, unknown>;
  counts: Record<string, unknown>;
}
/** Anonymises a creator's raw records into the bank (captions, replies, profile). */
export function normalise(options: NormaliseOptions): NormaliseResult;

export interface Splits {
  seed: string;
  ratios: Record<string, number>;
  counts: { posts: Record<string, number>; replies: Record<string, number> };
  posts: Record<string, string[]>;
  replies: Record<string, string[]>;
}
/** Splits the bank's replies by post and writes `splits.json`. */
export function writeSplits(options: { bankDir: string; seed: string }): Splits;

/** Measures style figures from the train and style-only replies and writes `style.json`. */
export function writeStyle(options: { bankDir: string }): { captions: { n: number }; replies: { n: number }; [key: string]: unknown };

/** Builds the retrieval chunks and writes `chunks.jsonl`. */
export function writeChunks(options: { bankDir: string; label?: string }): unknown[];

export interface DraftCardOptions {
  bankDir: string;
  cardDir: string;
  claude: Claude;
  model: string;
  version: number;
  budget: TokenBudget;
  seed: string;
  personaName?: string;
}
/** Drafts `card/v<version>.md`. */
export function draftCard(options: DraftCardOptions): Promise<{ card: string; exampleIds: string[]; warnings: string[]; [key: string]: unknown }>;

export interface RapidEvalOptions {
  bankDir: string;
  cardDir: string;
  version: number;
  claude: Claude;
  jev: Jev;
  genModel: string;
  jevModel: string;
  seed: string;
  budget: TokenBudget;
  personaName?: string;
  concurrency?: number;
}
/** Jev on the validation split: can it tell her real reply from the generated one. */
export function rapidEval(options: RapidEvalOptions): Promise<{ aggregate: Record<string, unknown>; [key: string]: unknown }>;

export interface MakeQueriesOptions {
  bankDir: string;
  evalDir: string;
  claude: Claude;
  model: string;
  seed: string;
  budget: TokenBudget;
  count?: number;
  concurrency?: number;
}
/** Writes the labelled retrieval query set. */
export function makeQueries(options: MakeQueriesOptions): Promise<unknown[]>;

/** The pipeline steps `build` runs, in order. */
export const STEPS: readonly ["normalise", "split", "style", "chunks", "draft-card", "rapid-eval", "queries"];

/** Flags of the `build` CLI, keyed by flag name without the dashes. */
export interface BuildArgs {
  creator: string;
  seed?: string;
  data?: string;
  raw?: string;
  label?: string;
  budget?: number | string;
  force?: string;
  "card-version"?: number | string;
  "card-model"?: string;
  "gen-model"?: string;
  "jev-model"?: string;
  "query-model"?: string;
}
/** Runs the whole pipeline; a step whose output exists is skipped unless forced. */
export function build(args: BuildArgs): Promise<TokenBudget>;

/** The GET-only Instagram transport. */
export interface InstagramClient {
  get(path: string): Promise<unknown>;
}
export interface ScrapeCaps {
  delayMs?: number;
  maxCommentPages?: number;
  maxThreads?: number;
  threadPages?: number;
}
export interface ScrapeOptions {
  client: InstagramClient;
  /** Optional; when given it must be the session's own account. */
  handle?: string;
  out?: string;
  caps?: ScrapeCaps;
  maxPosts?: number;
  now?: () => Date;
}
export interface ScrapeResult {
  dir: string;
  counts: {
    posts: number;
    capped: number;
    replies: number;
    exact: number;
    threadRoot: number;
    topLevel: number;
    nonText: number;
  };
  [key: string]: unknown;
}
/** Collects the session's own account, its posts and the owner's own replies, into the raw layout. */
export function scrape(options: ScrapeOptions): Promise<ScrapeResult>;

export interface EvalPersonaOptions {
  bankDir: string;
  cardDir: string;
  cacheDir: string;
  version: number;
  claude: Claude;
  genModel: string;
  judgeModel: string;
  seed: string;
  budget: TokenBudget;
  personaName?: string;
  concurrency?: number;
  limit?: number | null;
}
/** Judge scores and blind test over the test split. */
export function evalPersona(options: EvalPersonaOptions): Promise<{
  card_version: number;
  tokens_this_run: number;
  aggregate: Record<string, unknown>;
  [key: string]: unknown;
}>;

export interface LeakReport {
  files: number;
  hits: number;
  handles: number;
  shingles: number;
  perFile: Map<string, string[]>;
}
/** Scans `tree` for any caption, reply or handle of the raw scrape at `rawDir`. */
export function leakCheck(rawDir: string, tree: string): LeakReport;

/** The seven markdown sections of a persona card, in order. */
export const SECTIONS: readonly ["Identity", "Voice rules", "Examples", "Not known", "Never", "Selling voice", "AI honesty"];

export interface DraftPersonaOptions {
  /** A directory holding `raw/<handle>/`; `bank/` and `card/` are written beside it. */
  dir: string;
  handle: string;
  claude: Claude;
  cardModel: string;
  budget?: TokenBudget;
  seed?: string;
}
export interface DraftPersonaResult {
  counts: Record<string, number>;
  /** Exact train reply pairs found; under 15 the card is drafted from her own lines. */
  pairs: number;
  chunks: number;
  /** Replies the voice-marker rates were measured on. */
  markerTexts: number;
  exampleIds: number;
  warnings: string[];
  tokens: number;
}
/** Normalises, splits, measures and chunks the raw records, then drafts `card/v1.md`. No evaluation, no database. */
export function draftPersona(options: DraftPersonaOptions): Promise<DraftPersonaResult>;

/** The profile, posts and comments an Instagram data download holds for its own account. */
export interface InstagramExport {
  profile: { username: string; name: string; biography: string; website: string };
  posts: { shortcode: string; type: string; time: number; caption: string }[];
  comments: { owner: string; text: string; time: number; nonText: boolean }[];
  /** Every file whose contents were opened; direct messages never appear here. */
  filesRead: string[];
}
/** Reads a data download (a zip, or the folder it unpacks to). Writes nothing. */
export function readInstagramExport(path: string): InstagramExport;

export interface ExportToRawOptions {
  input: string;
  rawRoot: string;
  /** When given, must be the export's own account. */
  handle?: string;
  now?: () => Date;
}
/** Writes `<rawRoot>/<username>/{posts.jsonl, profile.json, NOTES.md}` for the export's own account. */
export function exportToRaw(options: ExportToRawOptions): {
  dir: string;
  username: string;
  displayName: string;
  counts: { posts: number; comments: number; gif: number; other_accounts: number; duplicates: number };
  filesRead: string[];
};

/** Raised for a zip the reader refuses (zip64, encrypted, damaged, unsafe names). */
export class ZipError extends Error {}
/** Raised when a handle other than the session's (or the export's) own account is asked for. */
export class NotOwnAccount extends Error {
  owner: string;
  requested: string;
}

/** The account a session cookie belongs to. */
export function resolveOwnHandle(client: InstagramClient): Promise<{ username: string; pk: string }>;
/** The GET-only Instagram transport over an injected fetch. */
export function createClient(options: {
  fetch?: typeof fetch;
  sessionId: string;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): InstagramClient;
