import { requireOnboarding } from "@/lib/auth/guards";
import { Button } from "@/components/ui/button";
import { Field, FormAlert, SoloPage } from "@/components/ui/field";
import { submitOnboarding } from "./actions";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  dob: "Enter a valid date of birth.",
  confirm: "Please confirm that you are 18 or older.",
};

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireOnboarding();
  const { error } = await searchParams;
  return (
    <SoloPage title="Before you continue" lead="Understudy is for adults only. We ask once.">
      {error && ERRORS[error] ? <FormAlert>{ERRORS[error]}</FormAlert> : null}
      <form action={submitOnboarding} className="flex flex-col gap-4">
        <Field id="dob" name="dob" type="date" label="Date of birth" required />
        <label className="flex min-h-11 items-center gap-3 text-[15px]">
          <input name="adult" type="checkbox" className="h-5 w-5 accent-[var(--color-accent)]" />I am 18 or older
        </label>
        <Button type="submit">Continue</Button>
      </form>
    </SoloPage>
  );
}
