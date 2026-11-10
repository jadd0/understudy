// Onboards a creator from her own Instagram, in two phases.
//
//   npx understudy init (--instagram-export <zip|folder> | --scrape-own) --email <address> --card-model <id> [flags]
//   npx understudy init --publish <dir>
//
// Phase 1 builds the persona bank and drafts the card into a directory outside the repository, then stops so
// the operator can read and edit it. It reads the database only to refuse a taken handle or email, and writes
// no row. Phase 2 publishes the newest card file: it creates the creator, loads the chunks and publishes the
// card, in that order, and can be run again after a failure.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/db/client";
import { creators, users } from "@/db/schema";
import { getConfig } from "@/lib/config";
import { embed, type EmbedResult } from "@understudy/providers";
import {
  HANDLE,
  MIN_PAIRS,
  NotOwnAccount,
  SECTIONS,
  SYNTHETIC_HANDLES,
  TokenBudget,
  createClaude,
  createClient,
  draftPersona,
  exportToRaw,
  leakCheck,
  readInstagramExport,
  resolveOwnHandle,
  scrape,
  type Claude,
} from "@understudy/persona";
import { latestCardVersion, loadPersona, readMarkers, UNBILLED_LIMITS } from "./load";
import { publishCard } from "./publish-card";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATE_FILE = "init.json";

/** A refusal with a message written for the operator. */
export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitError";
  }
}
/** A command line that does not parse. */
export class UsageError extends InitError {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export const USAGE = `Usage:
  npx understudy init (--instagram-export <zip|folder> | --scrape-own) --email <address> --card-model <id> [flags]
  npx understudy init --publish <dir>

Phase 1 builds the persona bank and drafts the card, then stops so you can read and edit it.
Phase 2 (--publish) creates the creator, loads her chunks and publishes the newest card file.

Source (exactly one)
  --instagram-export <path>   Instagram's own data download (JSON format), as the zip or the unzipped folder
  --scrape-own                the account IG_SESSIONID belongs to, collected by the scraper; never any other account
  --publish <dir>             publish the card drafted into <dir>

Phase 1 flags
  --email <address>           the creator's sign-in email (required)
  --card-model <id>           the Claude model that drafts the card (required)
  --handle <name>             optional; must be the account the export or session belongs to
  --display-name <name>       the name shown for her (default: the name on her profile)
  --out <dir>                 where the bank and card are written; empty or new, outside this repository
                              (default ~/.understudy/<handle>)

Needs CLAUDE_SECRET_KEY, and IG_SESSIONID for --scrape-own. VOYAGE_API_KEY is optional: without it the chunks
are stored without embeddings and retrieval uses full text. Direct messages are never read.`;

export type InitArgs =
  | { kind: "help" }
  | { kind: "publish"; dir: string }
  | {
      kind: "draft";
      source: { kind: "export"; input: string } | { kind: "scrape" };
      email: string;
      cardModel: string;
      handle?: string;
      displayName?: string;
      out?: string;
    };

const VALUE_FLAGS = ["instagram-export", "publish", "email", "card-model", "handle", "display-name", "out"] as const;
const SWITCHES = ["scrape-own", "help"] as const;

/** True when `target` is the repository or a path inside it, following links as far as the path exists. */
function insideRepo(target: string): boolean {
  let probe = path.resolve(target);
  const tail: string[] = [];
  while (!existsSync(probe)) {
    tail.unshift(path.basename(probe));
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const real = path.join(realpathSync(probe), ...tail);
  const rel = path.relative(realpathSync(REPO_ROOT), real);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function assertOutsideRepo(target: string) {
  if (insideRepo(target)) throw new InitError("--out must be outside this repository: the bank holds other people's comments");
}

/** Parses the flags after `init`. Paths are made absolute against the current directory. */
export function parseInitArgs(argv: string[]): InitArgs {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new UsageError(`unexpected argument ${JSON.stringify(arg)}`);
    const name = arg.slice(2);
    if ((SWITCHES as readonly string[]).includes(name)) {
      switches.add(name);
    } else if ((VALUE_FLAGS as readonly string[]).includes(name)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`);
      if (values.has(name)) throw new UsageError(`--${name} is given twice`);
      values.set(name, value);
      i++;
    } else {
      throw new UsageError(`unknown flag --${name}`);
    }
  }
  if (switches.has("help")) return { kind: "help" };

  const modes = [values.has("instagram-export"), switches.has("scrape-own"), values.has("publish")].filter(Boolean).length;
  if (modes !== 1) throw new UsageError("give exactly one of --instagram-export, --scrape-own and --publish");

  if (values.has("publish")) {
    const extra = [...values.keys(), ...switches].filter((name) => name !== "publish");
    if (extra.length > 0) throw new UsageError(`--publish takes no other flag (got --${extra[0]})`);
    return { kind: "publish", dir: path.resolve(values.get("publish")!) };
  }

  const email = values.get("email");
  const cardModel = values.get("card-model");
  if (!email) throw new UsageError("--email is required");
  if (!EMAIL.test(email)) throw new UsageError("--email is not an email address");
  if (!cardModel) throw new UsageError("--card-model is required");
  const handle = values.get("handle");
  if (handle !== undefined && (!HANDLE.test(handle) || /^\.+$/.test(handle))) throw new UsageError("--handle must be an Instagram username");
  const displayName = values.get("display-name")?.trim();
  if (displayName !== undefined && (displayName === "" || displayName.length > 80)) throw new UsageError("--display-name must be 1 to 80 characters");
  const out = values.get("out") === undefined ? undefined : path.resolve(values.get("out")!);
  if (out !== undefined) assertOutsideRepo(out);

  return {
    kind: "draft",
    source: values.has("instagram-export") ? { kind: "export", input: path.resolve(values.get("instagram-export")!) } : { kind: "scrape" },
    email,
    cardModel,
    handle,
    displayName,
    out,
  };
}

export type InitDeps = {
  /** The card drafter; defaults to the Claude adapter on `env.CLAUDE_SECRET_KEY`. */
  claude?: Claude;
  fetch?: typeof fetch;
  env: Record<string, string | undefined>;
  /** Phase 2: embeds the chunk texts, or `null` to store them without embeddings. */
  embedDocuments?: ((texts: string[]) => Promise<EmbedResult>) | null;
  /** Reads the platform's `retrieval.strategy`; defaults to the config table. */
  retrievalStrategy?: () => Promise<string>;
  /** The tree the leak check scans; defaults to this repository. */
  leakTree?: string;
  now?: () => Date;
  log?: (line: string) => void;
  homedir?: string;
  /** Pause between Instagram requests during `--scrape-own`. */
  scrapeDelayMs?: number;
};

type DraftOptions = Extract<InitArgs, { kind: "draft" }>;

type State = {
  format: 1;
  source: "instagram-export" | "scrape-own";
  handle: string;
  display_name: string;
  email: string;
  card_model: string;
  card_sha256: string;
  drafted_at: string;
  published_at: string | null;
  creator_id: string | null;
};

/** A path quoted for a POSIX shell, so the remove command printed to the operator can be pasted. */
const shellQuote = (value: string) => (/^[A-Za-z0-9_\/.@%+=:,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const normaliseEmail = (email: string) => email.trim().toLowerCase();

/**
 * Runs the leak check of `<dir>/raw` against the tree. Text copied from her posts or comments into any file
 * stops the run; a file that only names an account found in her data is a warning.
 */
function checkLeaks(dir: string, tree: string, log: (line: string) => void) {
  const raw = path.join(dir, "raw");
  if (!existsSync(raw)) throw new InitError(`${raw} is missing: the leak check reads it, so keep raw/ in the directory until the card is published (or run phase 1 again)`);
  const report = leakCheck(raw, tree);
  const copied: string[] = [];
  for (const [file, hits] of report.perFile) {
    if (hits.some((hit) => hit.startsWith("text["))) copied.push(file);
    else log(`warning: ${file} names an account that appears in her data`);
  }
  if (copied.length > 0) {
    throw new InitError(`text from her posts or comments appears in ${copied.length} file(s) of the tree (${copied.slice(0, 5).join(", ")}); remove it first`);
  }
}

function emptyDirectory(dir: string) {
  if (!existsSync(dir)) return;
  if (!statSync(dir).isDirectory()) throw new InitError("--out is a file, not a directory");
  if (readdirSync(dir).length > 0) throw new InitError("--out is not empty: delete it or pass another --out");
}

/** Phase 1. Builds the bank and drafts the card; writes no database row. */
export async function initDraft(opts: DraftOptions, deps: InitDeps) {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());
  if (!deps.env.CLAUDE_SECRET_KEY) throw new InitError("CLAUDE_SECRET_KEY is not set: Claude drafts the card");
  if (opts.out !== undefined) assertOutsideRepo(opts.out);
  const email = normaliseEmail(opts.email);

  // Whose account it is comes first: every refusal below happens before a directory exists or a model is called.
  // The export is read once and the session asked once; the build below is handed what they returned.
  let username: string;
  let exported: ReturnType<typeof readInstagramExport> | null = null;
  let client: ReturnType<typeof createClient> | null = null;
  let own: Awaited<ReturnType<typeof resolveOwnHandle>> | null = null;
  if (opts.source.kind === "export") {
    exported = readInstagramExport(opts.source.input);
    username = exported.profile.username;
  } else {
    const sessionId = deps.env.IG_SESSIONID;
    if (!sessionId) throw new InitError("IG_SESSIONID is not set: export your instagram.com sessionid cookie as IG_SESSIONID");
    client = createClient({ fetch: deps.fetch ?? globalThis.fetch, sessionId, delayMs: deps.scrapeDelayMs ?? 1500 });
    own = await resolveOwnHandle(client);
    username = own.username;
  }
  if (opts.handle !== undefined && opts.handle.toLowerCase() !== username.toLowerCase()) {
    throw new NotOwnAccount(username, opts.handle, opts.source.kind === "export" ? "export" : "session");
  }
  const handle = username;
  if (SYNTHETIC_HANDLES.includes(handle.toLowerCase())) throw new InitError(`@${handle} is a committed synthetic creator`);

  const [takenHandle] = await db.select({ id: creators.id }).from(creators).where(sql`lower(${creators.handle}) = ${handle.toLowerCase()}`);
  if (takenHandle) throw new InitError(`the handle @${handle} already belongs to a creator`);
  const [owner] = await db.select({ id: users.id, role: users.role }).from(users).where(sql`lower(${users.email}) = ${email}`);
  if (owner) {
    if (owner.role !== "creator") throw new InitError("that email already belongs to a fan or admin account");
    const [already] = await db.select({ handle: creators.handle }).from(creators).where(eq(creators.userId, owner.id));
    if (already) throw new InitError(`that email already belongs to the creator @${already.handle}`);
  }

  const out = opts.out ?? path.join(deps.homedir ?? os.homedir(), ".understudy", handle);
  assertOutsideRepo(out);
  emptyDirectory(out);
  const rawRoot = path.join(out, "raw");
  mkdirSync(out, { recursive: true });

  // From here `out` holds her data; a failure leaves it behind, so the operator is told how to clear it.
  let cardPath: string;
  let drafted: Awaited<ReturnType<typeof draftPersona>>;
  try {
    if (opts.source.kind === "export") {
      exportToRaw({ input: opts.source.input, data: exported!, rawRoot, handle, now });
    } else {
      await scrape({ client: client!, handle, own: own!, out: rawRoot, now });
    }

    const profilePath = path.join(rawRoot, handle, "profile.json");
    const profile = JSON.parse(readFileSync(profilePath, "utf8")) as { display_name?: string | null };
    const displayName = opts.displayName ?? profile.display_name ?? handle;
    writeFileSync(profilePath, JSON.stringify({ ...profile, display_name: displayName }, null, 2) + "\n");

    const posts = readFileSync(path.join(rawRoot, handle, "posts.jsonl"), "utf8").split("\n").filter(Boolean);
    if (!posts.some((line) => String((JSON.parse(line) as { caption?: unknown }).caption ?? "").trim() !== "")) {
      throw new InitError("none of her posts has a caption: there is nothing to build a persona from");
    }

    const claude = deps.claude ?? createClaude({ apiKey: deps.env.CLAUDE_SECRET_KEY });
    drafted = await draftPersona({ dir: out, handle, claude, cardModel: opts.cardModel, budget: new TokenBudget() });
    checkLeaks(out, deps.leakTree ?? REPO_ROOT, log);

    cardPath = path.join(out, "card", "v1.md");
    const state: State = {
      format: 1,
      source: opts.source.kind === "export" ? "instagram-export" : "scrape-own",
      handle,
      display_name: displayName,
      email,
      card_model: opts.cardModel,
      card_sha256: sha256(readFileSync(cardPath, "utf8")),
      drafted_at: now().toISOString(),
      published_at: null,
      creator_id: null,
    };
    writeFileSync(path.join(out, STATE_FILE), JSON.stringify(state, null, 2) + "\n");
  } catch (error) {
    log(`${out} holds a partial run (her data is in it); remove it before running again:`);
    log(`  rm -rf ${shellQuote(out)}`);
    throw error;
  }

  log(`bank: ${drafted.chunks} chunks from her captions; ${drafted.pairs} reply pairs${drafted.pairs < MIN_PAIRS ? " (the card is drafted from her own lines)" : ""}`);
  log(`card: ${cardPath}`);
  log("Read it, edit it, then run:");
  log(`  npx understudy init --publish ${out}`);
  return { out, handle, cardPath, drafted };
}

function readState(dir: string): State {
  const file = path.join(dir, STATE_FILE);
  if (!existsSync(file)) throw new InitError(`${file} is missing: run phase 1 first`);
  const state = JSON.parse(readFileSync(file, "utf8")) as Partial<State>;
  const text = (value: unknown) => typeof value === "string" && value !== "";
  if (state.format !== 1 || !text(state.handle) || !text(state.display_name) || !text(state.email) || !text(state.card_sha256)) {
    throw new InitError(`${file} is not a state file this version wrote`);
  }
  return state as State;
}

/** The card must still hold every section, in order, however much it was edited. */
function checkSections(card: string) {
  const headings = [...card.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  const missing = SECTIONS.filter((name) => !headings.includes(name));
  if (missing.length > 0) throw new InitError(`the card has lost section(s): ${missing.join(", ")}`);
  if (headings.join("|") !== SECTIONS.join("|")) throw new InitError(`the card's sections must be, in order: ${SECTIONS.join(", ")}`);
}

/**
 * Creates the creator's user and creator rows, or finds them: safe to run twice and from two processes. The user
 * row is taken first and the creator row second. A user that exists must already be a creator, and a handle that
 * exists must belong to that user.
 */
export async function ensureCreator(tx: Tx, input: { email: string; handle: string; displayName: string }) {
  const email = normaliseEmail(input.email);
  let [user] = await tx.select({ id: users.id, role: users.role }).from(users).where(sql`lower(${users.email}) = ${email}`);
  if (!user) {
    await tx.insert(users).values({ email, name: input.displayName, role: "creator", image: null }).onConflictDoNothing({ target: users.email });
    [user] = await tx.select({ id: users.id, role: users.role }).from(users).where(eq(users.email, email));
  }
  if (!user) throw new InitError("the user row could not be created");
  if (user.role !== "creator") throw new InitError("that email already belongs to a fan or admin account");

  // Handles are compared without regard to case, as phase 1 does; the unique index alone would let @Alice sit beside @alice.
  const sameHandle = sql`lower(${creators.handle}) = ${input.handle.toLowerCase()}`;
  const [held] = await tx.select({ userId: creators.userId }).from(creators).where(sameHandle);
  if (held && held.userId !== user.id) throw new InitError(`the handle @${input.handle} belongs to another user`);
  await tx.insert(creators).values({ userId: user.id, handle: input.handle, displayName: input.displayName }).onConflictDoNothing();
  const [creator] = await tx.select({ id: creators.id, userId: creators.userId }).from(creators).where(sameHandle).for("update");
  if (!creator) throw new InitError("that email already belongs to a creator with another handle");
  if (creator.userId !== user.id) throw new InitError(`the handle @${input.handle} belongs to another user`);
  return { userId: user.id, creatorId: creator.id };
}

/**
 * Chunks stored without embeddings are found by full text only. When the platform's retrieval strategy reads
 * vectors, publishing them would leave her with a bank that retrieval cannot see, so it is refused first.
 */
async function requireFullTextRetrieval(readStrategy: () => Promise<string>) {
  const strategy = await readStrategy();
  if (strategy === "fts") return;
  throw new InitError(
    `retrieval.strategy is ${JSON.stringify(strategy)}, which reads embeddings, and VOYAGE_API_KEY is not set, so her chunks would be stored without any. ` +
      `Either set VOYAGE_API_KEY and run --publish again, or set the retrieval.strategy config row to "fts" (full text) first.`,
  );
}

/** Phase 2. Safe to run again: every step finds what an earlier run left. */
export async function initPublish(dir: string, deps: InitDeps) {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());
  const state = readState(dir);
  const cardDir = path.join(dir, "card");
  const version = latestCardVersion(cardDir);
  const body = readFileSync(path.join(cardDir, `v${version}.md`), "utf8");

  // Everything that can refuse comes before the first write.
  checkSections(body);
  checkLeaks(dir, deps.leakTree ?? REPO_ROOT, log);
  if (!deps.embedDocuments) await requireFullTextRetrieval(deps.retrievalStrategy ?? (() => getConfig<string>("retrieval.strategy")));

  const { creatorId } = await db.transaction((tx) => ensureCreator(tx, { email: state.email, handle: state.handle, displayName: state.display_name }));

  const loaded = await loadPersona({ creatorId, dir, embedDocuments: deps.embedDocuments ?? null });
  const published = await publishCard(creatorId, body, readMarkers(dir));

  const edited = sha256(body) !== state.card_sha256;
  writeFileSync(
    path.join(dir, STATE_FILE),
    JSON.stringify({ ...state, published_at: state.published_at ?? now().toISOString(), creator_id: creatorId }, null, 2) + "\n",
  );
  log(`creator @${state.handle} ready`);
  log(`chunks: ${loaded.chunks}${deps.embedDocuments ? "" : " (no embeddings: retrieval uses full text)"}`);
  log(`card v${published.version} published (${edited ? "your edits" : "as drafted"})`);
  return { creatorId, version: published.version, chunks: loaded.chunks, edited, alreadyPublished: published.alreadyPublished };
}

// Errors whose messages are written for the operator. Anything else is reported by class and code only: a
// database or parser message can quote a row or a line of her data.
const OPERATOR_ERRORS = new Set(["InitError", "UsageError", "NotOwnAccount", "ZipError", "ExportError", "InstagramError", "ClaudeError", "BudgetExceeded", "ConfigMissing"]);

export async function main(argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  try {
    const args = parseInitArgs(argv);
    if (args.kind === "help") {
      console.log(USAGE);
      return 0;
    }
    if (!env.DATABASE_URL) throw new InitError("DATABASE_URL is not set");
    console.log(`database host: ${new URL(env.DATABASE_URL).host}`);
    const deps: InitDeps = { env, log: console.log };
    if (args.kind === "draft") {
      await initDraft(args, deps);
      return 0;
    }
    let embedDocuments: InitDeps["embedDocuments"] = null;
    if (env.VOYAGE_API_KEY) {
      const model = await getConfig<string>("retrieval.voyage_model");
      embedDocuments = (texts) => embed(texts, "document", { model, ...UNBILLED_LIMITS });
    }
    await initPublish(args.dir, { ...deps, embedDocuments });
    return 0;
  } catch (error) {
    const name = (error as Error)?.name ?? "Error";
    if (OPERATOR_ERRORS.has(name)) console.error((error as Error).message);
    else console.error(`init failed: ${name}${(error as { code?: string }).code ? ` ${(error as { code?: string }).code}` : ""}`);
    return error instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
