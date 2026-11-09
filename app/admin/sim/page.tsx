import { Suspense } from "react";
import { FormAlert } from "@/components/ui/field";
import { requireRole } from "@/lib/auth/guards";
import { getConfig } from "@/lib/config";
import { loadPersonas } from "@/lib/sim/persona";
import { PersonaList, Runs, RunsSkeleton, SimFrame, SimSwitch, SimSwitchSkeleton, SpawnBatch } from "./sections";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function AdminSimPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  // The guard decides before anything streams; the switch and the runs table stream behind skeletons.
  // Personas are read from files in the repo, so their section is part of the shell.
  await requireRole("admin");
  const { error } = await searchParams;
  const personas = loadPersonas();
  // Started once, awaited by the switch and by the runs table (the ticker runs only while the simulator is on).
  const enabled = getConfig<boolean>("sim.enabled");

  return (
    <SimFrame
      toggle={
        <Suspense fallback={<SimSwitchSkeleton />}>
          <SimSwitch enabled={enabled} />
        </Suspense>
      }
    >
      {error ? <FormAlert>Spawn refused: {error}</FormAlert> : null}
      <SpawnBatch />
      <Suspense fallback={<RunsSkeleton />}>
        <Runs personas={personas} enabled={enabled} />
      </Suspense>
      <PersonaList personas={personas} />
    </SimFrame>
  );
}
