import type { Role } from "@/lib/auth/guards";

const ROLE_LABEL: Record<Role, string> = { fan: "Fan", creator: "Creator", admin: "Trust & Safety" };

export const roleLabel = (role: Role): string => ROLE_LABEL[role];

/** The name shown in the account block: the profile name, else the local part of the email, else the role label. */
export function accountName(user: { name?: string | null; email?: string | null }, role: Role): string {
  const name = user.name?.trim();
  if (name) return name;
  const local = user.email?.split("@")[0]?.trim();
  return local || ROLE_LABEL[role];
}
