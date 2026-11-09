import { beforeEach, describe, expect, test, vi } from "vitest";
import { asViewer, makeAdmin, makeConversation, makeCreator, makeFan, moveToTs } from "@/lib/conversations/test-helpers";

const session = { current: null as { user: { id: string } } | null };
vi.mock("@/lib/auth", () => ({ auth: async () => session.current }));

process.env.PUSHER_APP_ID = "1";
process.env.PUSHER_KEY = "test-key";
process.env.PUSHER_SECRET = "test-secret";
process.env.PUSHER_CLUSTER = "eu";

const { POST } = await import("./route");

function request(channel: string) {
  const body = new URLSearchParams({ socket_id: "123.456", channel_name: channel });
  return new Request("http://localhost/api/pusher/auth", { method: "POST", body });
}
const as = (u: { id: string }) => void (session.current = { user: { id: u.id } });
beforeEach(() => void (session.current = null));

async function world() {
  const creator = await makeCreator();
  const fan = await makeFan();
  const other = await makeFan();
  const conv = await makeConversation(creator.id, fan.id);
  const otherConv = await makeConversation(creator.id, other.id);
  return { creator, fan, other, conv, otherConv };
}

describe("pusher auth", () => {
  test("fan_can_auth_own_conversation_only", async () => {
    const w = await world();
    as(w.fan);
    const ok = await POST(request(`private-conversation-${w.conv.id}`));
    expect(ok.status).toBe(200);
    expect(Object.keys(await ok.json())).toEqual(["auth"]);
    expect((await POST(request(`private-conversation-${w.otherConv.id}`))).status).toBe(403);
    expect((await POST(request(`private-creator-${w.creator.id}`))).status).toBe(403);
    expect((await POST(request("private-ts"))).status).toBe(403);
  });

  test("creator_cannot_auth_ts_channel", async () => {
    const w = await world();
    as({ id: w.creator.userId });
    expect((await POST(request("private-ts"))).status).toBe(403);
    expect((await POST(request(`private-creator-${w.creator.id}`))).status).toBe(200);
    expect((await POST(request(`private-creator-${(await makeCreator()).id}`))).status).toBe(403);
  });

  test("creator_cannot_auth_ts_conversation", async () => {
    const w = await world();
    await moveToTs(w.otherConv.id, "claimed");
    as({ id: w.creator.userId });
    expect((await POST(request(`private-conversation-${w.otherConv.id}`))).status).toBe(403);
    expect((await POST(request(`private-conversation-${w.conv.id}`))).status).toBe(200);
  });

  test("admin_can_auth_ts", async () => {
    const w = await world();
    await moveToTs(w.otherConv.id);
    const admin = await makeAdmin();
    as(admin);
    expect((await POST(request("private-ts"))).status).toBe(200);
    expect((await POST(request(`private-conversation-${w.otherConv.id}`))).status).toBe(200);
    // an admin sees every conversation, so it may listen on any of them
    expect((await POST(request(`private-conversation-${w.conv.id}`))).status).toBe(200);
    // and on a creator's inbox channel, which its view of the creator console listens on
    expect((await POST(request(`private-creator-${w.creator.id}`))).status).toBe(200);
    expect(asViewer(admin).role).toBe("admin");
  });

  test("signed_out_403", async () => {
    const w = await world();
    expect((await POST(request(`private-conversation-${w.conv.id}`))).status).toBe(403);
    expect((await POST(request("private-ts"))).status).toBe(403);
  });

  test("malformed requests and unknown channels are refused", async () => {
    const w = await world();
    as(w.fan);
    expect((await POST(request("presence-room"))).status).toBe(403);
    expect((await POST(new Request("http://localhost/api/pusher/auth", { method: "POST", body: new URLSearchParams({ channel_name: `private-conversation-${w.conv.id}` }) }))).status).toBe(403);
  });
});
