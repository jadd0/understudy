"use client";

import { useFormStatus } from "react-dom";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

/**
 * A form's submit button that reads its form's status. While the form submits, every submit button in it is disabled so
 * a second click cannot send twice, and the one that was clicked shows `pendingLabel`. A button with its own
 * `formAction` (several actions in one form) knows it was clicked when the pending action is its own. It must sit inside
 * the `<form>` it submits.
 */
export function SubmitButton({ pendingLabel, children, disabled, ...rest }: ComponentProps<typeof Button> & { pendingLabel: string }) {
  const { pending, action } = useFormStatus();
  const mine = pending && (typeof rest.formAction !== "function" || action === rest.formAction);
  return (
    <Button type="submit" disabled={pending || disabled} aria-busy={mine} {...rest}>
      {mine ? pendingLabel : children}
    </Button>
  );
}

/** The simulator's on/off switch, disabled while its form is saving. */
export function SubmitSwitch(props: Omit<ComponentProps<typeof Switch>, "disabled">) {
  const { pending } = useFormStatus();
  return <Switch {...props} disabled={pending} />;
}
