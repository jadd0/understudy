import { auth } from "@/lib/auth";
import { redirectHome } from "@/lib/auth/guards";
import { Turnstile } from "./turnstile";
import { getEnv } from "@/lib/env";
import { Button } from "@/components/ui/button";
import { Field, FormAlert, SoloPage } from "@/components/ui/field";
import { requestSignIn } from "./actions";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  turnstile: "Please complete the human check and try again.",
  email: "Enter a valid email address.",
  seat: "That team account needs the right password.",
};

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if ((await auth())?.user) await redirectHome();
  const { error } = await searchParams;
  return (
    <SoloPage title="Sign in" lead="We'll email you a one-tap sign-in link. No password needed.">
      {error && ERRORS[error] ? <FormAlert>{ERRORS[error]}</FormAlert> : null}
      <form action={requestSignIn} className="flex flex-col gap-4">
        <Field id="email" name="email" type="email" label="Email" required autoComplete="email" placeholder="you@example.com" />
        <details className="group rounded-field">
          <summary className="cursor-pointer list-none text-[13px] font-medium text-muted-2 hover:text-ink">
            Team account? Add the password
          </summary>
          <div className="mt-3">
            <Field
              id="password"
              name="password"
              type="password"
              label="Team password"
              autoComplete="current-password"
              hint="Only for the shared creator and admin accounts."
            />
          </div>
        </details>
        <Turnstile siteKey={getEnv().NEXT_PUBLIC_TURNSTILE_SITE_KEY} />
        <Button type="submit">Continue</Button>
      </form>
    </SoloPage>
  );
}
