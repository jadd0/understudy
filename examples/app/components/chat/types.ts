import type { Cursor, OlderPage, ThreadChanges } from "@/lib/conversations/window";
import type { Snapshot } from "@/lib/conversations/read";

export type { ActionResult } from "@/lib/conversations/result";
import type { ActionResult } from "@/lib/conversations/result";

/** Server actions a thread can call. Each page binds only the ones its role may use. */
export interface ThreadActions {
  refresh(): Promise<Snapshot>;
  /** Windowed views: the page before `before`, oldest first. Absent: the view keeps refreshing whole. */
  older?(before: Cursor): Promise<OlderPage>;
  /** Windowed views: what changed since `since`. Absent: the view keeps refreshing whole. */
  changes?(since: Cursor): Promise<ThreadChanges>;
  send(clientMsgId: string, body: string): Promise<ActionResult>;
  /** Fan only: tells the engine he is typing so it holds his turn. */
  typing?(): Promise<void>;
  unlock?(offerId: string): Promise<ActionResult>;
  tip?(idempotencyKey: string, amountCents: number): Promise<ActionResult>;
  takeover?(): Promise<ActionResult>;
  handBack?(): Promise<ActionResult>;
  release?(): Promise<ActionResult>;
  ban?(): Promise<ActionResult>;
  setAi?(on: boolean): Promise<ActionResult>;
  sendOffer?(itemId: string): Promise<ActionResult>;
  sendSuggested?(messageId: string, body: string): Promise<ActionResult>;
  discardSuggested?(messageId: string): Promise<ActionResult>;
}

export const REASON_TEXT: Record<string, string> = {
  minor: "may be under 18",
  self_harm: "self-harm risk",
  threat: "threat",
  location_offplatform: "wants to meet or move off-platform",
  payment_dispute: "payment dispute",
  hardship_escalation: "money hardship",
  explicit_live_chat: "explicit live chat",
  custom_request: "custom request",
  unsure: "the AI was unsure",
  verify_failed: "the AI's draft failed its checks",
  high_value_alert: "high-value fan",
  engine_error: "the AI hit an error",
};

/** A catalogue item the creator may offer from the console: shown with its catalogue price, never edited there. */
export interface OfferChoice {
  id: string;
  title: string;
  kind: string;
  priceCents: number;
}
