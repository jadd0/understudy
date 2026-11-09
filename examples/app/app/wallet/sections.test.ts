import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/config", () => ({ getConfig: vi.fn() }));
vi.mock("./actions", () => ({ topUp: vi.fn(), changeCap: vi.fn() }));

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

const text = (node: unknown): string =>
  typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" && "props" in node ? text((node as { props: { children?: unknown } }).props.children) : "";

describe("wallet top-up section", () => {
  test("without Stripe the controls are replaced by a plain note", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const { TopUpForms } = await import("./sections");
    const out = await TopUpForms();
    expect(text(out)).toBe("Top-ups are off on this install.");
  });

  test("with Stripe the preset and custom forms render", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_x";
    const { getConfig } = await import("@/lib/config");
    vi.mocked(getConfig).mockImplementation((async (k: string) => (k === "wallet.topup_options_cents" ? [500, 1000, 2000] : k === "wallet.topup_min_cents" ? 500 : 50000)) as never);
    const { TopUpForms } = await import("./sections");
    const out = (await TopUpForms()) as { props: { children: unknown[] } };
    expect(out.props.children).toHaveLength(2);
  });
});
