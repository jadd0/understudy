"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/guards";
import { makeQuery } from "@/lib/analytics/query";
import { isRangeKey, parseRange } from "@/lib/analytics/range";
import { isSimFilter } from "@/lib/analytics/scope";
import { listTurns, type TurnPage } from "@/lib/analytics/turns";
import { analyticsViewerOrNull } from "@/lib/analytics/viewer";
import { resolveUncredited } from "@/lib/wallet/uncredited";

/** Admin marks a paid-but-uncredited Checkout event handled (refunded in Stripe, or credited by hand). */
export async function resolveUncreditedAction(formData: FormData): Promise<void> {
  await requireRole("admin");
  const id = formData.get("id");
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return;
  await resolveUncredited(id, new Date());
  revalidatePath("/analytics");
}

export interface TurnsPageInput {
  range?: string;
  sim?: string;
  route?: string;
  outcome?: string;
  page?: number;
}

/**
 * One page of the turn explorer, fetched in place so changing page does not re-render the analytics page.
 * The viewer and scope come from the session exactly as the page resolves them; anyone else gets `null`.
 * Range and sim fall back to the page's defaults, and listTurns clamps the page and drops unknown filters.
 */
export async function turnsPageAction(input: TurnsPageInput): Promise<TurnPage | null> {
  const viewer = await analyticsViewerOrNull();
  if (!viewer) return null;
  const now = new Date();
  const range = parseRange(isRangeKey(input.range) ? input.range : "7d", now);
  const sim = isSimFilter(input.sim) ? input.sim : "all";
  const q = makeQuery({ ...viewer.scope, sim }, range, now);
  return listTurns(q, { route: input.route, outcome: input.outcome, page: Number(input.page) || 1 });
}
