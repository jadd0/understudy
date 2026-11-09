import NextAuth, { type DefaultSession } from "next-auth";
import Resend from "next-auth/providers/resend";
import type { EmailConfig } from "next-auth/providers/email";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@/db/client";
import { accounts, sessions, users, verificationTokens } from "@/db/schema";
import { seatAwareSender } from "./demo-seats";
import { sendDevLink } from "./dev-link";
import { emailConfigured, getEnv } from "@/lib/env";

type Role = "fan" | "creator" | "admin";

declare module "next-auth" {
  interface Session {
    user: { id: string; role: Role; adultConfirmedAt: Date | null } & DefaultSession["user"];
  }
}

/**
 * The email provider, id "resend" either way so the callback path is the same. With Resend configured the link is
 * mailed; without it, outside production, it is printed to the server console. In production with no Resend there
 * is no provider at all: the first use throws naming the keys, and no link is ever logged.
 */
export function emailProvider(source: Record<string, string | undefined> = process.env): EmailConfig {
  if (emailConfigured(source)) {
    return Resend({
      apiKey: source.RESEND_API_KEY,
      from: source.EMAIL_FROM,
      // Demo seats never get email; everyone else gets the provider's own email.
      sendVerificationRequest: seatAwareSender(Resend({}).sendVerificationRequest!, source as NodeJS.ProcessEnv),
    });
  }
  if (source.NODE_ENV === "production") throw new Error("Sign-in email is not configured: set RESEND_API_KEY and EMAIL_FROM");
  return {
    id: "resend",
    type: "email",
    name: "Console",
    from: "sign-in@localhost",
    maxAge: 24 * 60 * 60,
    options: {},
    sendVerificationRequest: seatAwareSender((p: { identifier: string; url: string }) => sendDevLink(p, source), source as NodeJS.ProcessEnv),
  };
}

// Config is built per request so that importing this module needs no environment.
export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const env = getEnv();
  return {
    adapter: DrizzleAdapter(db, {
      usersTable: users,
      accountsTable: accounts,
      sessionsTable: sessions,
      verificationTokensTable: verificationTokens,
    }),
    providers: [emailProvider()],
    session: { strategy: "database" },
    secret: env.AUTH_SECRET,
    pages: { signIn: "/signin", verifyRequest: "/signin/check-email" },
    callbacks: {
      session({ session, user }) {
        const row = user as typeof user & { role: Role; adultConfirmedAt: Date | null };
        session.user.id = row.id;
        session.user.role = row.role;
        session.user.adultConfirmedAt = row.adultConfirmedAt ?? null;
        return session;
      },
    },
  };
});
