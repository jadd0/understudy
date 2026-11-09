/** The server's settings, read once at start. A missing required variable stops the start; no value is ever printed. */
export interface ServerEnv {
  databaseUrl: string;
  apiKey: string;
  claudeKey: string | null;
  typesafeKey: string | null;
  webhookUrl: string | null;
  webhookSecret: string | null;
  port: number;
  /** The address to listen on: loopback by default, 0.0.0.0 in the container image. */
  host: string;
}

export class EnvMissing extends Error {
  constructor(public readonly names: string[]) {
    super(`missing environment: ${names.join(", ")}`);
    this.name = "EnvMissing";
  }
}

const opt = (v: string | undefined) => (v && v.trim() !== "" ? v : null);

/**
 * `fake` runs the server on scripted providers, so no model key is required. The webhook needs both its URL and its
 * secret, or neither: an unsigned webhook is never sent.
 */
export function readEnv(source: Record<string, string | undefined> = process.env, opts: { fake?: boolean } = {}): ServerEnv {
  const missing = ["DATABASE_URL", "UNDERSTUDY_API_KEY"].filter((k) => !opt(source[k]));
  if (!opts.fake && !opt(source.CLAUDE_SECRET_KEY)) missing.push("CLAUDE_SECRET_KEY");
  const webhookUrl = opt(source.WEBHOOK_URL);
  const webhookSecret = opt(source.WEBHOOK_SECRET);
  if (webhookUrl && !webhookSecret) missing.push("WEBHOOK_SECRET");
  if (missing.length > 0) throw new EnvMissing(missing);
  const port = source.PORT ? Number(source.PORT) : 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new EnvMissing(["PORT"]);
  return {
    databaseUrl: source.DATABASE_URL!,
    apiKey: source.UNDERSTUDY_API_KEY!,
    claudeKey: opt(source.CLAUDE_SECRET_KEY),
    typesafeKey: opt(source.TYPESAFE_SECRET_KEY),
    webhookUrl,
    webhookSecret: webhookUrl ? webhookSecret : null,
    port,
    host: opt(source.HOST) ?? "127.0.0.1",
  };
}
