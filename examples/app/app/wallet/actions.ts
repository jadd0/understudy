"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireAdultFan } from "@/lib/auth/guards";
import { setFanCap } from "@/lib/wallet/cap";
import { InvalidAmount } from "@/lib/wallet/errors";
import { dollarsToCents } from "@/lib/wallet/money";
import { stripeConfigured } from "@/lib/env";
import { StripeNotConfigured } from "@/providers/stripe";
import { startTopup } from "@/lib/wallet/topup";

async function origin() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/** A preset button posts `preset` in cents; the custom field posts `custom` in dollars. */
export async function topUp(formData: FormData) {
  const user = await requireAdultFan();
  if (!stripeConfigured()) redirect("/wallet?error=topups-off");
  const preset = formData.get("preset");
  const custom = formData.get("custom");
  const cents = typeof preset === "string" && preset !== "" ? Number(preset) : dollarsToCents(String(custom ?? ""));
  if (cents === null) redirect("/wallet?error=amount");

  let url: string;
  try {
    url = (await startTopup(user!.id!, cents, await origin())).url;
  } catch (e) {
    if (e instanceof InvalidAmount) redirect("/wallet?error=amount");
    if (e instanceof StripeNotConfigured) redirect("/wallet?error=topups-off");
    console.error("top-up failed", (e as Error).name);
    redirect("/wallet?error=stripe");
  }
  redirect(url);
}

/** The fan's own daily cap, entered in dollars. Raising waits out the cooling-off period. */
export async function changeCap(formData: FormData) {
  const user = await requireAdultFan();
  const cents = dollarsToCents(String(formData.get("cap") ?? ""));
  if (cents === null) redirect("/wallet?error=cap");
  try {
    const res = await setFanCap(user!.id!, cents);
    redirect(res.pending ? "/wallet?cap=pending" : "/wallet?cap=set");
  } catch (e) {
    if (e instanceof InvalidAmount) redirect("/wallet?error=cap");
    throw e;
  }
}
