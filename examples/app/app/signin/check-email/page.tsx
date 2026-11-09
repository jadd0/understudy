import { SoloPage } from "@/components/ui/field";
import { emailConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

export default function CheckEmailPage() {
  const lead = emailConfigured()
    ? "We sent you a sign-in link. Open it on this device to continue."
    : "No mail is configured on this install. Open the sign-in link printed in the server console on this device to continue.";
  return <SoloPage title="Check your email" lead={lead} />;
}
