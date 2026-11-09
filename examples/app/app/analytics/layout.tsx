import type { ReactNode } from "react";
import { AppShell } from "@/components/ui/app-shell";

export default function Layout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
