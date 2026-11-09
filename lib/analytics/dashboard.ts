import { getCost } from "./cost";
import { getHandoffs } from "./handoffs";
import { getLatency } from "./latency";
import { getOfferFunnel } from "./offers";
import type { Query } from "./query";
import { getResponsible } from "./responsible";
import { getRevenue, getTopFans } from "./revenue";
import { getRoutes } from "./routes";
import { getVolume } from "./volume";

/** Every KPI for one query, each from its own tested function. The page and the METRICS.md report both call this. */
export async function getDashboard(q: Query) {
  const [volume, routes, handoffs, offers, revenue, topFans, latency, cost, responsible] = await Promise.all([
    getVolume(q),
    getRoutes(q),
    getHandoffs(q),
    getOfferFunnel(q),
    getRevenue(q),
    getTopFans(q, 10),
    getLatency(q),
    getCost(q),
    getResponsible(q),
  ]);
  return { volume, routes, handoffs, offers, revenue, topFans, latency, cost, responsible };
}
export type Dashboard = Awaited<ReturnType<typeof getDashboard>>;
