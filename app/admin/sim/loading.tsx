import { loadPersonas } from "@/lib/sim/persona";
import { PersonaList, RunsSkeleton, SimFrame, SimSwitchSkeleton, SpawnBatch } from "./sections";

export default function Loading() {
  return (
    <SimFrame toggle={<SimSwitchSkeleton />}>
      <SpawnBatch />
      <RunsSkeleton />
      <PersonaList personas={loadPersonas()} />
    </SimFrame>
  );
}
