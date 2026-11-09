"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { seatHandoffPath } from "@/lib/auth/seat-handoff";
import { z } from "zod";
import { signIn } from "@/lib/auth";
import { captureSeatLink, checkSeatPassword, isDemoSeat } from "@/lib/auth/demo-seats";
import { seatAccountReady } from "@/lib/auth/seat-account";
import { verifyTurnstile } from "@/lib/auth/turnstile";

const emailSchema = z.string().trim().toLowerCase().pipe(z.email());

/** Logs why a sign-in was refused (never the email, password or token), then sends the visitor back with the error. */
function refuse(error: "turnstile" | "email" | "seat", why: string = error): never {
  console.warn(`signin refused: ${why}`);
  redirect(`/signin?error=${error}`);
}

export async function requestSignIn(formData: FormData) {
  const token = formData.get("cf-turnstile-response");
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  // Turnstile first: nothing is sent or stored for a visitor who has not passed it.
  const human = await verifyTurnstile(typeof token === "string" ? token : null, ip);
  if (!human) refuse("turnstile");

  const email = emailSchema.safeParse(formData.get("email"));
  if (!email.success) refuse("email");

  // Demo seats: password instead of email; Auth.js still verifies the token and makes the session.
  if (isDemoSeat(email.data)) {
    if (!checkSeatPassword(formData.get("password"))) refuse("seat", "wrong or missing seat password");
    // Only a seat the seed has already created with its role: otherwise Auth.js would create a fan row for it.
    if (!(await seatAccountReady(email.data))) refuse("seat", "seat account not seeded");
    const link = await captureSeatLink(() => signIn("resend", { email: email.data, redirect: false, redirectTo: "/" }));
    if (!link) refuse("seat", "no sign-in link captured");
    // Not redirect(link): Next would follow it server-side and the session cookie would never reach the browser.
    redirect(seatHandoffPath(link));
  }

  await signIn("resend", { email: email.data, redirectTo: "/" });
}
