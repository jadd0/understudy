"use server";

import { redirect } from "next/navigation";
import { applyOnboarding } from "@/lib/auth/onboarding";
import { requireOnboarding } from "@/lib/auth/guards";

export async function submitOnboarding(formData: FormData) {
  // Identity comes from the session; the form carries only the date and the checkbox.
  const user = await requireOnboarding();
  const result = await applyOnboarding(
    user.id,
    { dob: formData.get("dob"), adult: formData.get("adult") === "on" },
    new Date(),
  );
  switch (result.status) {
    case "invalid_dob":
      redirect("/onboarding?error=dob");
    case "unconfirmed":
      redirect("/onboarding?error=confirm");
    case "blocked":
      redirect("/blocked");
    default:
      redirect("/");
  }
}
