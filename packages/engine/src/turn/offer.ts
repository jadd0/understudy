import { buildOwnedShortlist, buildShortlist, pickOffer, type ShortlistItem } from "../conversation/offer";
import { DeciderUnavailable } from "../ports/decider";
import type { Route } from "../types";
import type { Batch, TurnState } from "./state";

/**
 * The offer route's catalogue pick: the item the reply will lead into, or none (and the route falls back to words
 * alone) when nothing is affordable or Jev gives no usable pick.
 */
export async function chooseOffer(s: TurnState, b: Batch, route: Route): Promise<{ route: Route; offerItem: ShortlistItem | null }> {
  if (route.name !== "offer") return { route, offerItem: null };
  const { cfg, lease, acc } = s;
  const { host } = s.ctx;
  let offerItem: ShortlistItem | null = null;
  try {
    // Only items the debit would accept: the same cap rule, so an offer is never one the cap then refuses.
    const affordable = (items: ShortlistItem[]) => items.filter((it) => host.capAllows(b.facts.spentTodayCents, it.priceCents, b.facts.capCents));
    const unowned = affordable(await buildShortlist(host, lease.creatorId, lease.fanId, lease.conversationId, route.offerKinds));
    // Nothing new he can take: offer something he already owns, a favourite worth unlocking again. It is charged
    // like any purchase, so the same cap rule applies.
    const shortlist =
      unowned.length > 0 ? unowned : affordable(await buildOwnedShortlist(host, lease.creatorId, lease.fanId, lease.conversationId, route.offerKinds));
    const t0 = s.ctx.deps.clock.now();
    const pick = await pickOffer(s.ctx.deps.decider, shortlist, b.jevState);
    acc.msJevIn = (acc.msJevIn ?? 0) + (s.ctx.deps.clock.now() - t0);
    if (pick.usage) s.addCost("offer_pick", cfg.prices[cfg.jevModel], pick.usage);
    offerItem = pick.item;
  } catch (e) {
    if (!(e instanceof DeciderUnavailable)) throw e;
    // No usable pick: answer without an offer.
  }
  let next = route;
  if (!offerItem) next = { ...route, name: route.fallback ?? "reply" };
  acc.route = next.name;
  return { route: next, offerItem };
}
