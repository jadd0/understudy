import NextAuth, { type DefaultSession } from "next-auth";
import Resend from "next-auth/providers/resend";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@/db/client";
import { accounts, sessions, users, verificationTokens } from "@/db/schema";
import { seatAwareSender } from "./demo-seats";
import { getEnv } from "@/lib/env";

type Role = "fan" | "creator" | "admin";

declare module "next-auth" {
  interface Session {
    user: { id: string; role: Role; adultConfirmedAt: Date | null } & DefaultSession["user"];
  }
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
    providers: [
      Resend({
        apiKey: env.RESEND_API_KEY,
        from: env.EMAIL_FROM,
        // Demo seats never get email; everyone else gets the provider's own email.
        sendVerificationRequest: seatAwareSender(Resend({}).sendVerificationRequest!),
      }),
    ],
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
