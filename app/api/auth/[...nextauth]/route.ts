import type { NextRequest } from "next/server";
import { handlers } from "@/lib/auth";

export const { GET } = handlers;

// Email sign-in starts only from the Turnstile-checked server action. A direct POST to the
// provider endpoint would send mail without the check, so it is refused here.
export async function POST(req: NextRequest) {
  if (new URL(req.url).pathname.startsWith("/api/auth/signin")) {
    return new Response("Forbidden", { status: 403 });
  }
  return handlers.POST(req);
}
