/*
 * The simulator page's parts. The page renders the frame, the spawn form and the personas (read from files
 * in the repo) at once; the on/off switch and the runs table stream behind their skeletons. loading.tsx renders
 * the same parts with every skeleton.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { desc } from "drizzle-orm";
import { touchesSharedState, type Persona } from "@/lib/sim/persona";
import { Badge } from "@/components/ui/badge";
import { Skeleton, SkeletonGroup, SkeletonLine } from "@/components/ui/skeleton";
import { db } from "@/db/client";
import { simRuns } from "@/db/schema";
import { beatResults } from "@/lib/sim/run";
import { summariseRun } from "@/lib/sim/score";
import { LiveTicker } from "./live-ticker";
import { OpenAsFan } from "./open-as-fan";
import { SubmitButton, SubmitSwitch } from "./pending";
import { resetAction, spawnAllAction, spawnMixAction, spawnPersonaAction, spawnRandomAction, setSimEnabledAction, stopAction, stopAllAction } from "./actions";

const isLive = (status: string) => status === "queued" || status === "running" || status === "waiting_human";

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(3)}`;

/** Status chip tone: what needs a person is loud, what is moving is ink, what has ended is quiet. */
const statusTone = (status: string): "accent" | "ink" | "neutral" =>
  status === "waiting_human" || status === "failed" ? "accent" : isLive(status) ? "ink" : "neutral";

const STATUS_LABEL: Record<string, string> = { waiting_human: "needs you" };

const FIELD = "h-10 rounded-field border border-transparent bg-surface px-3 text-[14px] text-ink outline-none focus:border-line-focus focus:bg-ground";
const LABEL = "flex flex-col gap-1.5 text-[13px] font-medium text-ink-2";
const CHECK = "flex items-center gap-2 text-[13px] text-muted-2";

function Section({ title, hint, action, children }: { title: string; hint?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-t border-line pt-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-[17px] font-semibold tracking-[-0.01em]">{title}</h2>
          {hint ? <p className="max-w-[65ch] text-[14px] leading-relaxed text-muted-2">{hint}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

const ModeSelect = () => (
  <label className={LABEL}>
    Mode
    <select name="mode" defaultValue="auto" className={`${FIELD} pr-8`}>
      <option value="auto">Auto</option>
      <option value="demo">Demo</option>
    </select>
  </label>
);

/** Personas grouped the way an admin picks them: the everyday fans first, then edge cases, then the ones with side effects. */
function groups(personas: Persona[]): { title: string; hint: string; items: Persona[] }[] {
  const special = (p: Persona) => p.slug === "minor" || touchesSharedState(p);
  return [
    { title: "Everyday fans", hint: "The normal mix draws from these.", items: personas.filter((p) => !special(p) && p.weight >= 5) },
    { title: "Edge cases", hint: "Abuse, AI questions, disputes, caps and the rest.", items: personas.filter((p) => !special(p) && p.weight < 5) },
    {
      title: "Special",
      hint: "The scripted minor, and personas that change Juno's real AI switch or never-list while they run.",
      items: personas.filter(special),
    },
  ].filter((g) => g.items.length > 0);
}


/** The page's frame: the title, the intro line and the on/off switch slot. */
export function SimFrame({ toggle, children }: { toggle: ReactNode; children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-[1040px] flex-col gap-8 px-4 py-6 md:py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="text-[28px] font-semibold tracking-[-0.02em]">Fan simulator</h1>
          <p className="max-w-[60ch] text-[14px] leading-relaxed text-muted-2">
            Each spawn makes a fresh sim fan that talks to Juno through the real send path.
          </p>
        </div>
        {toggle}
      </header>
      {children}
    </main>
  );
}

/** Spawn a batch: a static form, so it is part of the shell. */
export function SpawnBatch() {
  return (
    <section className="flex flex-col gap-4 rounded-row border border-line p-4 md:p-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-[17px] font-semibold tracking-[-0.01em]">Spawn a batch</h2>
        <p className="text-[14px] leading-relaxed text-muted-2">
          Auto plays every step itself. Demo paces each message so you can watch, and waits for you at takeovers and bans.
        </p>
      </div>
      <form className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-[96px_160px_140px]">
          <label className={LABEL}>
            Count
            <input name="count" type="number" min={1} max={20} defaultValue={3} className={`${FIELD} tabular-nums`} />
          </label>
          <label className={LABEL}>
            Seed
            <input name="seed" placeholder="Random" className={`${FIELD} placeholder:text-muted`} />
          </label>
          <ModeSelect />
        </div>
        <div className="flex flex-col gap-2">
          <label className={CHECK}>
            <input name="include_minor" type="checkbox" /> Include the scripted minor
          </label>
          <label className={CHECK}>
            <input name="include_shared" type="checkbox" /> Include personas that change Juno&apos;s real settings
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton formAction={spawnRandomAction} pendingLabel="Spawning…">
            Spawn random
          </SubmitButton>
          <SubmitButton formAction={spawnMixAction} variant="secondary" pendingLabel="Spawning…">
            Normal mix
          </SubmitButton>
          <SubmitButton formAction={spawnAllAction} variant="secondary" pendingLabel="Spawning…">
            Every persona
          </SubmitButton>
        </div>
        <p className="text-[12px] text-muted">Count and seed apply to Spawn random. Normal mix is the six everyday fans.</p>
      </form>
    </section>
  );
}

/** One fan at a time, grouped. */
export function PersonaList({ personas }: { personas: Persona[] }) {
  return (
    <Section title="Personas" hint="Spawn one fan. Demo is paced for watching; auto runs at full speed.">
      <div className="flex flex-col gap-6">
        {groups(personas).map((g) => (
          <div key={g.title} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <h3 className="text-[15px] font-semibold">{g.title}</h3>
              <p className="text-[13px] text-muted-2">{g.hint}</p>
            </div>
            <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 md:grid-cols-2">
              {g.items.map((p) => (
                <li key={p.slug} className="flex items-center justify-between gap-3 rounded-row border border-line px-4 py-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2 text-[15px] font-medium">
                      {p.slug}
                      {touchesSharedState(p) ? <Badge tone="accent">changes settings</Badge> : null}
                      {p.slug === "minor" ? <Badge tone="accent">scripted</Badge> : null}
                    </span>
                    <span className="text-[13px] text-muted-2">{p.goal}</span>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    {(["demo", "auto"] as const).map((m) => (
                      <form key={m} action={spawnPersonaAction}>
                        <input type="hidden" name="persona" value={p.slug} />
                        <input type="hidden" name="mode" value={m} />
                        {touchesSharedState(p) ? <input type="hidden" name="include_shared" value="on" /> : null}
                        <SubmitButton variant="secondary" className="h-9 px-3 text-[13px]" pendingLabel="Spawning…" aria-label={`Spawn ${p.slug} in ${m} mode`}>
                          {m === "demo" ? "Demo" : "Auto"}
                        </SubmitButton>
                      </form>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}

/** The simulator's on/off switch. */
export async function SimSwitch({ enabled: enabledP }: { enabled: Promise<boolean> }) {
  const enabled = await enabledP;
  return (
    <form action={setSimEnabledAction} className="flex items-center gap-3 rounded-row border border-line px-4 py-2.5">
      <span className="flex flex-col">
        <span className="text-[14px] font-semibold">{enabled ? "Simulator on" : "Simulator off"}</span>
        <span className="text-[12px] text-muted-2">{enabled ? "Spawns and ticks run" : "Spawns are refused"}</span>
      </span>
      <SubmitSwitch on={enabled} name="enabled" label="Simulator on or off" />
    </form>
  );
}

/** The switch's bordered box at its real size (two text lines, 62px tall), with the switch track. */
export function SimSwitchSkeleton() {
  return (
    <SkeletonGroup label="Loading simulator switch">
      <div className="flex items-center gap-3 rounded-row border border-line px-4 py-2.5">
        <span className="flex flex-col">
          <SkeletonLine width={96} lineHeight={21} bar={10} />
          <SkeletonLine width={116} lineHeight={18} bar={8} />
        </span>
        <Skeleton className="h-7 w-12 rounded-full" />
      </div>
    </SkeletonGroup>
  );
}

const RUNS_TITLE = "Runs";
const RUNS_HINT = "Newest first. Violations break the safety bar; pending checkpoints wait on engine work and never fail a run.";

/** The runs table, newest first; its title counts the live runs, so the whole section streams. */
export async function Runs({ personas, enabled: enabledP }: { personas: Persona[]; enabled: Promise<boolean> }) {
  const [enabled, runs] = await Promise.all([enabledP, db.select().from(simRuns).orderBy(desc(simRuns.createdAt)).limit(50)]);
  const anyLive = runs.some((r) => isLive(r.status));
  const liveCount = runs.filter((r) => isLive(r.status)).length;
  return (
    <Section
      title={liveCount > 0 ? `Runs (${liveCount} live)` : "Runs"}
      hint="Newest first. Violations break the safety bar; pending checkpoints wait on engine work and never fail a run."
      action={
        <div className="flex flex-wrap gap-2">
          <form action={stopAllAction}>
            <SubmitButton variant="secondary" className="h-10 px-4 text-[14px]" pendingLabel="Stopping…">
              Stop all
            </SubmitButton>
          </form>
          <form action={resetAction}>
            <SubmitButton variant="secondary" className="h-10 px-4 text-[14px]" pendingLabel="Clearing…">
              Clear sim data
            </SubmitButton>
          </form>
        </div>
      }
    >
      {enabled && anyLive ? <LiveTicker /> : null}
      {runs.length === 0 ? (
        <div className="flex flex-col gap-1 rounded-row border border-dashed border-line-2 px-4 py-8 text-center">
          <p className="text-[15px] font-medium">No runs yet</p>
          <p className="text-[14px] text-muted-2">Spawn a batch above, or pick one persona below.</p>
        </div>
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
          <table className="w-full min-w-[720px] border-collapse text-left text-[14px]">
            <thead>
              <tr>
                {["Persona", "Status", "Beat", "Violations", "Pending", "Cost", "Open", ""].map((h, i) => (
                  <th key={h || i} className="border-b border-line py-2 pr-4 text-[12px] font-medium text-muted-2">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const sum = summariseRun(beatResults(r.log));
                const total = personas.find((p) => p.slug === r.personaSlug)?.beats.length ?? 0;
                return (
                  <tr key={r.id} className="align-top">
                    <td className="border-b border-line py-3 pr-4 font-medium">{r.personaSlug}</td>
                    <td className="border-b border-line py-3 pr-4">
                      <span className="flex flex-col items-start gap-1">
                        <Badge tone={statusTone(r.status)}>{STATUS_LABEL[r.status] ?? r.status}</Badge>
                        {r.stopReason ? <span className="text-[12px] text-muted-2">{r.stopReason}</span> : null}
                      </span>
                    </td>
                    <td className="border-b border-line py-3 pr-4 tabular-nums">
                      {r.nextBeat}/{total}
                    </td>
                    <td className={`border-b border-line py-3 pr-4 tabular-nums ${sum.violations > 0 ? "font-semibold text-danger" : ""}`}>{sum.violations}</td>
                    <td className="border-b border-line py-3 pr-4 tabular-nums text-muted-2">{sum.pending}</td>
                    <td className="border-b border-line py-3 pr-4 tabular-nums text-muted-2">{usd(r.costMicros)}</td>
                    <td className="border-b border-line py-3 pr-4">
                      <span className="flex flex-col gap-1">
                        {/* The run's conversation in the creator console and in the admin's T&S thread view. */}
                        {r.conversationId ? (
                          <Link href={`/console/${r.conversationId}`} className="text-accent underline">
                            console
                          </Link>
                        ) : null}
                        {r.conversationId ? (
                          <Link href={`/admin/${r.conversationId}`} className="text-accent underline">
                            admin view
                          </Link>
                        ) : null}
                        <Link href="/analytics" className="text-accent underline">
                          turns
                        </Link>
                      </span>
                    </td>
                    <td className="border-b border-line py-3">
                      <div className="flex flex-col items-start gap-2">
                        <OpenAsFan runId={r.id} />
                        {isLive(r.status) ? (
                          <form action={stopAction}>
                            <input type="hidden" name="run" value={r.id} />
                            <SubmitButton variant="secondary" className="h-9 px-3 text-[13px]" pendingLabel="Stopping…">
                              Stop
                            </SubmitButton>
                          </form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

/** The runs section while it loads: the plain title, the two buttons, and table rows at the real row height. */
export function RunsSkeleton() {
  return (
    <Section title={RUNS_TITLE} hint={RUNS_HINT} action={<div className="flex flex-wrap gap-2"><Skeleton className="h-10 w-[92px] rounded-full" /><Skeleton className="h-10 w-[132px] rounded-full" /></div>}>
      <SkeletonGroup label="Loading runs" className="flex flex-col">
        <div className="border-b border-line py-2">
          <SkeletonLine width="60%" lineHeight={18} bar={8} />
        </div>
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-start gap-4 border-b border-line py-3">
            <SkeletonLine width={["22%", "18%", "26%", "20%", "16%"][i]} lineHeight={21} bar={10} />
            <Skeleton className="h-[20.5px] w-[64px] rounded-full" />
            <SkeletonLine width="30%" lineHeight={21} bar={10} />
          </div>
        ))}
      </SkeletonGroup>
    </Section>
  );
}
