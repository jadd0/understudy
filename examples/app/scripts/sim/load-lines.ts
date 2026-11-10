import { pathToFileURL } from "node:url";
import { getConfig } from "@/lib/config";
import { loadLines } from "@/lib/sim/lines";
import { embed } from "@jadd0/understudy-providers";

/** Embeds data/sim/lines/*.jsonl into sim_lines. Idempotent. */
export async function main(): Promise<void> {
  const model = await getConfig<string>("retrieval.voyage_model");
  const out = await loadLines((texts) => embed(texts, "document", { model, retries: 3, retryDelayMs: 20_000, batchSize: 100, intervalMs: 1000 }));
  console.log(`sim lines: ${out.lines} loaded, ${out.tokens} tokens`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0), (e) => {
    console.error("sim:load-lines failed:", (e as { code?: string; name?: string }).code ?? (e as Error).name);
    process.exit(1);
  });
}
