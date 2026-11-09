"use server";

import { signOut } from "@/lib/auth";

/** Auth.js ends the session (the database row is deleted) and sends the visitor to the sign-in page. */
export async function signOutAction() {
  await signOut({ redirectTo: "/signin" });
}
