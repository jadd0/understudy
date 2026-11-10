import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeCreator as makeBareCreator, makeFan } from "@/lib/conversations/test-helpers";
import { makePersona, setEngineConfig } from "@jadd0/understudy-engine/testing";

const session = { current: null as { user: { id: string } } | null };
vi.mock("@/lib/auth", () => ({ auth: async () => session.current }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/conversations/events", () => ({ getEvents: () => ({ emit: async () => {} }) }));

const { cameFrom, chatHrefFor, walletHrefFor } = await import("./chat-link");
const { changeCap, topUp } = await import("./actions");
const WalletPage = (await import("./page")).default;
const ChatPage = (await import("../chat/page")).default;

const as = (u: { id: string }) => void (session.current = { user: { id: u.id } });
const form = (o: Record<string, string>) => Object.entries(o).reduce((f, [k, v]) => (f.set(k, v), f), new FormData());
const digest = async (p: Promise<unknown>) => p.then(() => null, (e: { digest?: string }) => String(e.digest ?? e));
beforeEach(() => void (session.current = null));

async function scene() {
  await setEngineConfig();
  const creator = await makeBareCreator();
  await makePersona(creator.id);
  const fan = await makeFan();
  as(fan);
  return { creator, fan };
}

describe("the chat a fan left to reach the wallet", () => {
  test("hrefs carry the handle, encoded; none means plain /chat", () => {
    expect(walletHrefFor("juno")).toBe("/wallet?c=juno");
    expect(walletHrefFor("a b&c")).toBe("/wallet?c=a%20b%26c");
    expect(chatHrefFor("juno")).toBe("/chat?c=juno");
    expect(chatHrefFor(null)).toBe("/chat");
    expect(chatHrefFor(undefined)).toBe("/chat");
  });

  test("cameFrom accepts a reachable creator in any case and refuses everything else", async () => {
    const w = await scene();
    expect(await cameFrom(w.fan.id, w.creator.handle)).toBe(w.creator.handle);
    expect(await cameFrom(w.fan.id, w.creator.handle.toUpperCase())).toBe(w.creator.handle);
    const bare = await makeBareCreator();
    for (const bad of ["no-such-handle", "", null, undefined, 7, [w.creator.handle, w.creator.handle], bare.handle]) {
      expect(await cameFrom(w.fan.id, bad)).toBeNull();
    }
  });

  test("the wallet page's way back is the chat it came from, and plain /chat for a handle nobody has", async () => {
    const w = await scene();
    const back = async (c: unknown) => {
      const page = (await WalletPage({ searchParams: Promise.resolve(c === undefined ? {} : { c }) as never })) as { props: { chatHref: string } };
      return page.props.chatHref;
    };
    expect(await back(w.creator.handle)).toBe(`/chat?c=${w.creator.handle}`);
    expect(await back("no-such-handle")).toBe("/chat");
    expect(await back(undefined)).toBe("/chat");
    expect(await back([w.creator.handle, w.creator.handle])).toBe("/chat");
  });

  test("the chat opens the wallet with its own handle, also when the URL named none", async () => {
    const w = await scene();
    const walletHrefOf = async (c: string | undefined) => {
      const page = (await ChatPage({ searchParams: Promise.resolve(c === undefined ? {} : { c }) })) as { props: { children: { props: { children: { type: (p: unknown) => Promise<{ props: { walletHref: string } }>; props: unknown } } } } };
      const thread = page.props.children.props.children;
      return (await thread.type(thread.props)).props.walletHref;
    };
    expect(await walletHrefOf(w.creator.handle)).toBe(`/wallet?c=${w.creator.handle}`);
    // the creator this fan reaches by default
    const none = await walletHrefOf(undefined);
    expect(none).toMatch(/^\/wallet\?c=.+/);
  });

  test("the chat is a 404 for a creator with no published card", async () => {
    const w = await scene();
    const bare = await makeBareCreator();
    await expect(ChatPage({ searchParams: Promise.resolve({ c: bare.handle }) })).rejects.toMatchObject({ digest: expect.stringMatching(/404|NOT_FOUND/) });
    await expect(ChatPage({ searchParams: Promise.resolve({ c: "no-such-handle" }) })).rejects.toMatchObject({ digest: expect.stringMatching(/404|NOT_FOUND/) });
    expect(w.creator.handle).toBeTruthy();
  });

  test("the wallet's own redirects keep the handle, and drop one nobody can reach", async () => {
    const w = await scene();
    expect(await digest(changeCap(form({ cap: "abc", c: w.creator.handle })))).toMatch(new RegExp(`/wallet\\?error=cap&c=${w.creator.handle};`));
    expect(await digest(changeCap(form({ cap: "abc", c: "no-such-handle" })))).toMatch(/\/wallet\?error=cap;/);
    expect(await digest(changeCap(form({ cap: "abc" })))).toMatch(/\/wallet\?error=cap;/);
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect(await digest(topUp(form({ preset: "500", c: w.creator.handle })))).toMatch(new RegExp(`/wallet\\?error=topups-off&c=${w.creator.handle};`));
  });
});
