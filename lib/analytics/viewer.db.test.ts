import { describe, expect, test, vi } from "vitest";
import { makeAdmin, makeCreator } from "@/lib/conversations/test-helpers";

const session = { current: null as { user: { id: string } } | null };
vi.mock("@/lib/auth", () => ({ auth: async () => session.current }));

const { requireAnalyticsViewer } = await import("./viewer");

describe("requireAnalyticsViewer", () => {
  test("an admin keeps the admin view although the console route now admits admins too", async () => {
    const admin = await makeAdmin();
    session.current = { user: { id: admin.id } };
    expect(await requireAnalyticsViewer()).toMatchObject({ userId: admin.id, isAdmin: true });
  });

  test("a creator gets the creator view", async () => {
    const creator = await makeCreator();
    session.current = { user: { id: creator.userId } };
    expect(await requireAnalyticsViewer()).toMatchObject({ userId: creator.userId, isAdmin: false });
  });
});
