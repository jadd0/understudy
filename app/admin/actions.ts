"use server";

import { after } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { ban, discardSuggested, releaseConversation, sendAsCreator, sendSuggested, takeOverConversation } from "@/lib/conversations/controls";
import { getEvents } from "@/lib/conversations/events";
import { assertVisible, getSnapshot, type Viewer } from "@/lib/conversations/read";
import { getChanges, getOlderMessages } from "@/lib/conversations/paging";
import { toResult, windowRead } from "@/lib/conversations/result";
import { defaultDeps } from "@/lib/host/deps";
import { processConversation } from "@understudy/engine";

/** The signed-in admin. The id and role come from the session, never from an argument. */
async function viewer(): Promise<Viewer> {
  const user = await requireRole("admin");
  return { id: user!.id!, role: "admin" };
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

export async function replyAction(conversationId: string, clientMsgId: string, body: string) {
  const v = await viewer();
  return toResult(() => sendAsCreator(v, conversationId, body, getEvents(), clientMsgId));
}

export async function sendSuggestedAction(messageId: string, body: string) {
  const v = await viewer();
  return toResult(() => sendSuggested(v, messageId, body, getEvents()));
}

export async function discardSuggestedAction(messageId: string) {
  const v = await viewer();
  return toResult(() => discardSuggested(v, messageId));
}

/** Resolves the conversation's open Trust & Safety handoff and hands it back to the AI. */
export async function releaseAction(conversationId: string) {
  const v = await viewer();
  return toResult(async () => {
    await releaseConversation(v, conversationId, getEvents());
    // Fan messages sent while the chat was paused are answered now, not at the next sweep.
    after(async () => processConversation(conversationId, await defaultDeps()));
  });
}

/** Bans the fan who owns this conversation; the fan id is read from the conversation, not from the client. */
export async function banAction(conversationId: string) {
  const v = await viewer();
  return toResult(async () => {
    const conv = await assertVisible(v, conversationId);
    await ban(v, conv.fanId);
  });
}
