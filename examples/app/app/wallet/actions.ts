"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireAdultFan } from "@/lib/auth/guards";
import { cameFrom } from "./chat-link";
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

/**
 * The wallet's own URL, keeping the chat the fan came from. The form posts that chat's handle as `c`; it is checked
 * again here, so a made-up one is dropped and the fan's way back is plain `/chat`.
 */
async function walletUrl(fanId: string, formData: FormData, query: string) {
  const handle = (await cameFrom(fanId, formData.get("c"))) ?? undefined;
  const parts = [query, handle ? `c=${encodeURIComponent(handle)}` : ""].filter(Boolean);
  return { handle, url: `/wallet${parts.length ? `?${parts.join("&")}` : ""}` };
}

/** A preset button posts `preset` in cents; the custom field posts `custom` in dollars. */
export async function topUp(formData: FormData) {
  const user = await requireAdultFan();
  const back = (query: string) => walletUrl(user!.id!, formData, query);
  if (!stripeConfigured()) redirect((await back("error=topups-off")).url);
  const preset = formData.get("preset");
  const custom = formData.get("custom");
  const cents = typeof preset === "string" && preset !== "" ? Number(preset) : dollarsToCents(String(custom ?? ""));
  if (cents === null) redirect((await back("error=amount")).url);

  let url: string;
  try {
    const { handle } = await back("");
    url = (await startTopup(user!.id!, cents, await origin(), undefined, handle)).url;
  } catch (e) {
    if (e instanceof InvalidAmount) redirect((await back("error=amount")).url);
    if (e instanceof StripeNotConfigured) redirect((await back("error=topups-off")).url);
    console.error("top-up failed", (e as Error).name);
    redirect((await back("error=stripe")).url);
  }
  redirect(url);
}

/** The fan's own daily cap, entered in dollars. Raising waits out the cooling-off period. */
export async function changeCap(formData: FormData) {
  const user = await requireAdultFan();
  const back = (query: string) => walletUrl(user!.id!, formData, query);
  const cents = dollarsToCents(String(formData.get("cap") ?? ""));
  if (cents === null) redirect((await back("error=cap")).url);
  try {
    const res = await setFanCap(user!.id!, cents);
    redirect((await back(res.pending ? "cap=pending" : "cap=set")).url);
  } catch (e) {
    if (e instanceof InvalidAmount) redirect((await back("error=cap")).url);
    throw e;
  }
}
