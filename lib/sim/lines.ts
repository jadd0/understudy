import { globSync, readFileSync } from "node:fs";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { withTx } from "@/db/client";
import { simLines } from "@/db/schema";
import type { EmbedResult } from "@/providers/voyage/embed";

export const LineSchema = z.object({ persona: z.string().min(1), intent: z.string().min(1), lang: z.enum(["en", "es"]), text: z.string().min(1).max(300) }).strict();
export type Line = z.infer<typeof LineSchema>;

export const LINES_GLOB = "data/sim/lines/*.jsonl";

export function readLines(pattern = LINES_GLOB): Line[] {
  return globSync(pattern)
    .sort()
    .flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l, i) => {
          const parsed = LineSchema.safeParse(JSON.parse(l));
          if (!parsed.success) throw new Error(`${file}:${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`);
          return parsed.data;
        }),
    );
}

/**
 * Embeds the line library and replaces `sim_lines` in one transaction, so loading twice leaves the same rows.
 * Embedding happens first: a Voyage failure writes nothing.
 */
export async function loadLines(embedDocuments: (texts: string[]) => Promise<EmbedResult>, lines: Line[] = readLines()): Promise<{ lines: number; tokens: number }> {
  if (lines.length === 0) throw new Error("no sim lines to load");
  const { embeddings, totalTokens } = await embedDocuments(lines.map((l) => l.text));
  if (embeddings.length !== lines.length) throw new Error("embedding count mismatch; nothing written");
  await withTx(async (tx) => {
    await tx.execute(sql`delete from sim_lines`);
    for (let i = 0; i < lines.length; i += 100) {
      await tx.insert(simLines).values(lines.slice(i, i + 100).map((l, j) => ({ ...l, embedding: embeddings[i + j] })));
    }
  });
  return { lines: lines.length, tokens: totalTokens };
}
