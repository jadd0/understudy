/**
 * Reviews sim conversations reply by reply with Jev and writes the evidence for a human write-up.
 *
 *   npm run sim:review -- --label set1 --batch <batchId> [--batch <batchId> ...]
 *
 * Writes docs/evals/sim-review/<label>.json (every reply with its flags and the turn's routing) and <label>.md (the
 * transcripts with flags inline and a flag count table). Reads the dev database; writes nothing to it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { messages, simRuns, turns } from "@/db/schema";
import { getConfig } from "@/lib/config";
import { flagsOf, REVIEW_QUESTIONS, replyUnits, type ChatLine } from "@/lib/sim/review";
import { TypeSafeDecider } from "@/providers/typesafe/decider";

function args() {
  const a = process.argv.slice(2);
  const batches: string[] = [];
  let label = "review";
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--batch") batches.push(a[++i]);
    else if (a[i] === "--label") label = a[++i];
  }
  if (batches.length === 0) throw new Error("pass at least one --batch <id>");
  return { batches, label };
}

async function main() {
  const { batches, label } = args();
  const decider = new TypeSafeDecider({
    apiKey: process.env.TYPESAFE_SECRET_KEY ?? "",
    model: await getConfig<string>("jev.model"),
    timeoutMs: 30_000,
    backoffMs: 500,
    fetch: globalThis.fetch,
  });
  const runs = await db.select().from(simRuns).where(inArray(simRuns.batchId, batches)).orderBy(asc(simRuns.createdAt));
  const out: unknown[] = [];
  const md: string[] = [`# Sim review: ${label}`, "", `Batches: ${batches.join(", ")}. Questions: ${REVIEW_QUESTIONS.map((q) => q.key).join(", ")}.`, ""];
  const counts: Record<string, number> = {};
  let replies = 0;
  for (const run of runs) {
    if (!run.conversationId) continue;
    const rows = await db
      .select({ sender: messages.sender, body: messages.body, turnId: messages.turnId, status: messages.status, suggested: messages.suggested })
      .from(messages)
      .where(eq(messages.conversationId, run.conversationId))
      .orderBy(asc(messages.createdAt), asc(messages.id));
    const lines: ChatLine[] = rows.filter((r) => r.status === "sent" && !r.suggested).map((r) => ({ sender: r.sender, body: r.body, turnId: r.turnId }));
    const turnRows = await db.select().from(turns).where(eq(turns.conversationId, run.conversationId)).orderBy(asc(turns.createdAt));
    const byId = new Map(turnRows.map((t) => [t.id, t]));
    md.push(`## ${run.personaSlug} (run ${run.id.slice(0, 8)}, ${run.status})`, "");
    const units = replyUnits(lines);
    const reviewed = [];
    for (const u of units) {
      const t = byId.get(u.turnId);
      let answers: Record<string, string> = {};
      try {
        const r = await decider.ask(REVIEW_QUESTIONS, { state: { earlier_messages: u.earlier, his_new_messages: u.fan, her_reply: u.reply } });
        answers = Object.fromEntries(r.answers.map((a) => [a.key, a.value]));
      } catch (e) {
        answers = { error: (e as Error).name };
      }
      const flags = flagsOf(answers);
      replies++;
      for (const f of flags) counts[f] = (counts[f] ?? 0) + 1;
      const jevIn = (t?.jevIn ?? null) as { parsed?: { intent?: string; intentP?: number; thread?: string; pitchFitP?: number | null } } | null;
      const meta = t ? `${t.route}/${t.outcome}${t.offerId ? " +offer" : ""} · ${jevIn?.parsed?.intent ?? "?"} ${jevIn?.parsed?.intentP ?? ""} · thread ${jevIn?.parsed?.thread ?? "-"} · fit ${jevIn?.parsed?.pitchFitP ?? "-"}` : "";
      reviewed.push({ ...u, answers, flags, route: t?.route ?? null, outcome: t?.outcome ?? null, offered: Boolean(t?.offerId), jevIn: jevIn?.parsed ?? null });
      for (const f of u.fan) md.push(`> **him:** ${f}`);
      for (const r of u.reply) md.push(`> **her:** ${r}`);
      md.push(`> _${meta}_${flags.length ? ` · **flags: ${flags.join(", ")}**` : ""}`, "");
    }
    // Human or platform lines after the last AI reply (a handoff ending) are shown so the ending is visible.
    out.push({ run: run.id, persona: run.personaSlug, status: run.status, stopReason: run.stopReason, log: run.log, replies: reviewed });
  }
  md.push("## Flag counts", "", "| flag | replies | share |", "|---|---|---|");
  for (const q of REVIEW_QUESTIONS) {
    const n = counts[q.key] ?? 0;
    md.push(`| ${q.key} | ${n} | ${replies ? Math.round((100 * n) / replies) : 0}% |`);
  }
  md.push("", `${replies} replies reviewed.`);
  const dir = path.join(process.cwd(), "docs/evals/sim-review");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${label}.json`), JSON.stringify(out, null, 2));
  writeFileSync(path.join(dir, `${label}.md`), md.join("\n") + "\n");
  console.log(`reviewed ${replies} replies → docs/evals/sim-review/${label}.{md,json}`);
  console.log(Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ") || "no flags");
  process.exit(0);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
