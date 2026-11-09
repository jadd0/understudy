import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { auth } from "@/lib/auth";
import { canSubscribe } from "@/lib/conversations/read";
import { parseChannel } from "@/providers/pusher/channels";
import { createPusherServer, pusherKeysFromEnv } from "@/providers/pusher/events";

const refuse = () => new Response("forbidden", { status: 403 });

/**
 * Authorises a private channel for the signed-in user. The role and the flag are read fresh from the user row,
 * and the channel name is parsed against the three shapes this app publishes; anything else is refused.
 */
export async function POST(req: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return refuse();
  const [user] = await db.select({ role: users.role, flaggedAt: users.flaggedAt }).from(users).where(eq(users.id, userId));
  if (!user || user.flaggedAt) return refuse();

  const form = await req.formData().catch(() => null);
  const socketId = form?.get("socket_id");
  const channelName = form?.get("channel_name");
  if (typeof socketId !== "string" || typeof channelName !== "string" || !/^\d+\.\d+$/.test(socketId)) return refuse();
  const channel = parseChannel(channelName);
  if (!channel) return refuse();
  if (!(await canSubscribe({ id: userId, role: user.role }, channel))) return refuse();

  const keys = pusherKeysFromEnv();
  if (!keys) return new Response("realtime is not configured", { status: 503 });
  return Response.json(createPusherServer(keys).authorizeChannel(socketId, channelName));
}
