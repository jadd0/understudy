import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { chatter } from "@/lib/host/deps";

export const maxDuration = 60;

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Vercel Cron calls this every minute with `Authorization: Bearer $CRON_SECRET`. */
export async function GET(request: Request) {
  if (!authorised(request)) return new NextResponse("unauthorised", { status: 401 });
  const result = await (await chatter()).sweep();
  return NextResponse.json(result);
}
