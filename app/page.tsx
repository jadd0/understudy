import { redirectHome } from "@/lib/auth/guards";

export const dynamic = "force-dynamic";

export default async function Home() {
  await redirectHome();
  return null;
}
