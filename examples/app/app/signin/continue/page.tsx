import { notFound } from "next/navigation";
import { SoloPage } from "@/components/ui/field";
import { safeCallbackPath } from "@/lib/auth/seat-handoff";
import { GoTo } from "./go-to";

export const dynamic = "force-dynamic";

/** Demo-seat sign-in, last hop: the browser itself opens the Auth.js callback, so it receives the session cookie. */
export default async function ContinueSignIn({ searchParams }: { searchParams: Promise<{ to?: string }> }) {
  const to = safeCallbackPath((await searchParams).to);
  if (!to) notFound();
  return (
    <SoloPage title="Signing you in" lead="One moment.">
      <GoTo href={to} />
    </SoloPage>
  );
}
