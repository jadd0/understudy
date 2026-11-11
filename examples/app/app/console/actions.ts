"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { requireConsole } from "@/lib/auth/guards";
import {
  addItem, discardSuggested, handBackConversation, moveItem, releaseConversation, sendAsCreator, sendOfferAsCreator, sendSuggested, setConversationAi,
  setGlobalAi, setItemActive, setItemPrice, setNeverList, takeOverConversation,
} from "@/lib/conversations/controls";
import { getEvents } from "@/lib/conversations/events";
import { getSnapshot, type Viewer } from "@/lib/conversations/read";
import { getChanges, getOlderMessages } from "@/lib/conversations/paging";
import { toResult, windowRead } from "@/lib/conversations/result";
import { understudy } from "@/lib/host/deps";
import { dollarsToCents } from "@/lib/wallet/money";

/**
 * The signed-in creator, or an admin in the console. The id comes from the session and the role from the
 * user row read fresh on every call, never from an argument, so an admin acts as itself: the controls write its
 * messages as sender "admin" with its own user id, and refuse it the creator-only actions (hand-back, offers, the
 * per-conversation AI switch).
 */
async function viewer(): Promise<Viewer> {
  const user = await requireConsole();
  return { id: user.id, role: user.role };
}

export async function refreshThread(conversationId: string) {
  return getSnapshot(await viewer(), conversationId);
}

/** The page of messages before `before`. */
export async function olderThread(conversationId: string, before: string) {
  const v = await viewer();
  return windowRead(() => getOlderMessages(v, conversationId, before));
}

/** What changed since `since`. */
export async function threadChanges(conversationId: string, since: string) {
  const v = await viewer();
  return windowRead(() => getChanges(v, conversationId, since));
}

export async function takeoverAction(conversationId: string) {
  const v = await viewer();
  return toResult(() => takeOverConversation(v, conversationId, getEvents()));
}

export async function handBackAction(conversationId: string) {
  const v = await viewer();
  return toResult(async () => {
    await handBackConversation(v, conversationId, getEvents());
    // Fan messages after the creator's last reply are answered now, not at the next sweep.
    after(async () => (await understudy()).processConversation(conversationId));
  });
}

/** Admin only: returns a conversation an admin holds to the AI, as /admin does. */
export async function releaseAction(conversationId: string) {
  const v = await viewer();
  return toResult(async () => {
    await releaseConversation(v, conversationId, getEvents());
    after(async () => (await understudy()).processConversation(conversationId));
  });
}

export async function replyAction(conversationId: string, clientMsgId: string, body: string) {
  const v = await viewer();
  return toResult(() => sendAsCreator(v, conversationId, body, getEvents(), clientMsgId));
}

export async function sendOfferAction(conversationId: string, itemId: string) {
  const v = await viewer();
  return toResult(() => sendOfferAsCreator(v, conversationId, itemId, getEvents()));
}

export async function conversationAiAction(conversationId: string, on: boolean) {
  const v = await viewer();
  return toResult(() => setConversationAi(v, conversationId, on));
}

export async function sendSuggestedAction(messageId: string, body: string) {
  const v = await viewer();
  return toResult(() => sendSuggested(v, messageId, body, getEvents()));
}

export async function discardSuggestedAction(messageId: string) {
  const v = await viewer();
  return toResult(() => discardSuggested(v, messageId));
}

// ---- settings (plain form actions; they redirect back with a notice) ---------------------------------------

export async function saveGlobalAi(formData: FormData) {
  const v = await viewer();
  const r = await toResult(() => setGlobalAi(v, formData.get("ai") === "on"));
  revalidatePath("/console/settings");
  redirect(r.ok ? "/console/settings?saved=ai" : "/console/settings?error=ai");
}

export async function saveNeverList(formData: FormData) {
  const v = await viewer();
  const terms = String(formData.get("terms") ?? "").split("\n");
  const r = await toResult(() => setNeverList(v, terms));
  redirect(r.ok ? "/console/settings?saved=never" : "/console/settings?error=never");
}

export async function savePrice(formData: FormData) {
  const v = await viewer();
  const cents = dollarsToCents(String(formData.get("price") ?? ""));
  if (cents === null) redirect("/console/settings?error=price");
  const r = await toResult(() => setItemPrice(v, String(formData.get("itemId") ?? ""), cents));
  redirect(r.ok ? "/console/settings?saved=price" : "/console/settings?error=price");
}

/** The "Add item" form: the price is typed in dollars and converted here, once, to whole cents. */
export async function addItemAction(formData: FormData) {
  const v = await viewer();
  const cents = dollarsToCents(String(formData.get("price") ?? ""));
  if (cents === null) redirect("/console/settings?error=item_price");
  const r = await toResult(() =>
    addItem(v, { kind: String(formData.get("kind") ?? ""), title: String(formData.get("title") ?? ""), teaser: String(formData.get("teaser") ?? ""), cents }),
  );
  redirect(r.ok ? "/console/settings?saved=item_added" : "/console/settings?error=item");
}

export async function retireItemAction(formData: FormData) {
  const v = await viewer();
  const r = await toResult(() => setItemActive(v, String(formData.get("itemId") ?? ""), false));
  redirect(r.ok ? "/console/settings?saved=item_retired" : "/console/settings?error=item_edit");
}

export async function restoreItemAction(formData: FormData) {
  const v = await viewer();
  const r = await toResult(() => setItemActive(v, String(formData.get("itemId") ?? ""), true));
  redirect(r.ok ? "/console/settings?saved=item_restored" : "/console/settings?error=item_edit");
}

export async function moveItemAction(formData: FormData) {
  const v = await viewer();
  const direction = formData.get("direction") === "up" ? "up" : "down";
  const r = await toResult(() => moveItem(v, String(formData.get("itemId") ?? ""), direction));
  redirect(r.ok ? "/console/settings?saved=item_moved" : "/console/settings?error=item_edit");
}
