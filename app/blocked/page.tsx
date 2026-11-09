import { SoloPage } from "@/components/ui/field";
import { auth } from "@/lib/auth";
import { threatLine } from "./last-line";

export const dynamic = "force-dynamic";

export default async function BlockedPage() {
  const session = await auth();
  const line = session?.user?.id ? await threatLine(session.user.id) : null;
  return (
    <SoloPage title="Access unavailable" lead="This account can't use Understudy. If you think this is a mistake, contact support.">
      {line ? <p className="rounded-field bg-surface px-4 py-3 text-[15px] leading-relaxed">{line}</p> : null}
    </SoloPage>
  );
}
