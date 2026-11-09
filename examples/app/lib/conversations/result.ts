import { InvalidAmount } from "@/lib/wallet/errors";
import { Forbidden, InvalidInput, OfferAlreadyOpen } from "./controls";
import { ConversationNotFound } from "./read";
import { TakeoverRefused } from "./actions";
import { BadCursor } from "./cursor";

export type ActionResult = { ok: true } | { ok: false; error: string };

/** Runs a control and turns its refusals into a message for the page; anything unexpected is logged by class only. */
export async function toResult(fn: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await fn();
    return { ok: true };
  } catch (e) {
    if (e instanceof Forbidden || e instanceof ConversationNotFound || e instanceof TakeoverRefused) {
      return { ok: false, error: "That is not available to you." };
    }
    if (e instanceof OfferAlreadyOpen) return { ok: false, error: "That offer is already open in this chat." };
    if (e instanceof InvalidInput) return { ok: false, error: e.field === "body" ? "Write a message first." : "That value is not valid." };
    if (e instanceof InvalidAmount) return { ok: false, error: "Enter a price above $0." };
    console.error("control failed", (e as Error).name);
    return { ok: false, error: "Something went wrong. Try again." };
  }
}

/**
 * Runs a windowed thread read for a server action. A damaged or foreign cursor, or a conversation outside
 * the viewer's scope, becomes one plain error with no detail; anything else is logged by class only and rethrown
 * as a generic error, so no SQL or stack reaches the browser.
 */
export async function windowRead<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BadCursor || e instanceof ConversationNotFound) throw new Error("That is not available to you.");
    console.error("window read failed", (e as Error).name);
    throw new Error("Something went wrong. Try again.");
  }
}
