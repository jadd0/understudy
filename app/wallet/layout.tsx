import type { ReactNode } from "react";
import { AppShell } from "@/components/ui/app-shell";
import { requireAdultFan } from "@/lib/auth/guards";

export default async function Layout({ children }: { children: ReactNode }) {
  // The guard runs here, before loading.tsx's skeleton can stream, so a wrong role is a real redirect or 404.
  // The page runs it again: a layout is not re-rendered on client navigation.
  await requireAdultFan();
  return <AppShell>{children}</AppShell>;
}
