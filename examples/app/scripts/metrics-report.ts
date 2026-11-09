// Writes docs/quality/METRICS.md from the database: every KPI over the last 30 days, all creators (an admin's view).
import path from "node:path";
import { db } from "@/db/client";
import { creators } from "@/db/schema";
import { makeQuery } from "@/lib/analytics/query";
import { parseRange } from "@/lib/analytics/range";
import { writeMetrics } from "@/lib/analytics/report";

async function main() {
  const now = new Date();
  const ids = (await db.select({ id: creators.id }).from(creators)).map((c) => c.id);
  const q = makeQuery({ creatorIds: ids, includeTs: true }, parseRange("30d", now), now);
  const file = path.join(process.cwd(), "docs/quality/METRICS.md");
  await writeMetrics(file, q, `all creators (${ids.length}), read-only, Trust & Safety included`);
  console.log(`wrote ${file} at ${now.toISOString()}`);
  process.exit(0);
}

main().catch((e) => {
  const err = e as { name?: string; code?: string; cause?: { code?: string } };
  console.error(`metrics-report failed: ${err?.name} ${err?.code ?? err?.cause?.code ?? ""}`);
  process.exit(1);
});
