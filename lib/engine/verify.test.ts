import { describe, expect, test } from "vitest";
import { FakeDecider } from "@/providers/fake/decider";
import { codeChecks, mentionsMoney, qualityOnly, verifyDraft } from "@/lib/engine/verify";
import type { RouteName } from "@/lib/engine/types";

const GOOD = { reasks: "no", on_persona: "yes", explicitness: "flirty", offplatform_or_meetup: "no", is_refusal: "no", admits_ai: "no", promises_price_or_free: "no" };

async function verify(draft: string, script: Record<string, string> = {}, route: RouteName = "reply", stopReason: string | null = "end_turn", never: string[] = []) {
  const decider = new FakeDecider({ script: { ...GOOD, ...script } });
  const out = await verifyDraft(decider, { draft, fanMessage: "hi", earlier: [], route, neverList: never, stopReason }, () => 0);
  return { out, decider };
}

describe("money fence", () => {
  test.each(["it's $0 babe", "only 9.99 dollars", "ten bucks", "USD 5", "€5", "£3", "that's 20 euros", "5usd"])("flags %s", (t) => {
    expect(mentionsMoney(t)).toBe(true);
  });
  test.each(["i dollarize nothing lol", "see you at 5 pm", "give me a sec", "you're a buck-wild one", "thinking of you 24 7"])("passes %s", (t) => {
    expect(mentionsMoney(t)).toBe(false);
  });
  test("money_regex_catches_new_patterns", () => {
    const caught = [
      "just 99 cents", "fifty cents", "cents 50", "on the house", "On The House babe", "no charge for u", "it's for free", "gratis",
      "20%", "20 %", "half off, 50% off", "¥500", "₹99", "₩5000", "9.99", "only 4.50 lol", "5 bux", "ten bux",
    ];
    for (const t of caught) expect(mentionsMoney(t), t).toBe(true);
    const clean = ["feel free to ask", "freely", "no charger needed", "scent of cents-ible", "3.1 stars", "version 2.0", "on the housetop", "gratisfied"];
    for (const t of clean) expect(mentionsMoney(t), t).toBe(false);
  });
  test("never_list_blocks_snapchat_draft: whole words, any case, a plural counts", () => {
    const never = ["snapchat", "phone number", "meet up", "Cash App", "address"];
    for (const d of ["add me on Snapchat", "SNAPCHAT?", "my phone number is", "my phone numbers", "lets meetup", "lets meet  up", "use cashapp", "whats ur address", "your addresses"]) {
      expect(codeChecks(d, never), d).toEqual(["never_list"]);
    }
    for (const d of ["my phone died", "i'm addressing it", "snapchatty", "meeting up soon", "hey you"]) {
      expect(codeChecks(d, never), d).toEqual([]);
    }
  });
  test("code checks name the failure and the never list is case-insensitive", () => {
    expect(codeChecks("say the price is $0", [])).toEqual(["money"]);
    expect(codeChecks("my ex was awful", ["My Ex"])).toEqual(["never_list"]);
    expect(codeChecks("  ", [])).toContain("empty");
    expect(codeChecks("hey you", ["", "  "])).toEqual([]);
  });
});

describe("verifyDraft", () => {
  test("a clean draft passes and Jev saw only the draft, the fan message and the chat so far", async () => {
    const { out, decider } = await verify("hey you, missed you");
    expect(out.ok).toBe(true);
    expect(decider.calls).toHaveLength(1);
    expect(Object.keys(decider.calls[0].state as object).sort()).toEqual(["draft", "earlier_messages", "fan_message"]);
  });

  test("a money draft fails in code and never reaches Jev", async () => {
    const { out, decider } = await verify("its $0 for you");
    expect(out.failures).toEqual(["money"]);
    expect(decider.calls).toHaveLength(0);
  });

  test("'it's free babe' fails on Jev's promises_price_or_free", async () => {
    const { out } = await verify("it's free babe", { promises_price_or_free: "yes" });
    expect(out).toMatchObject({ ok: false, failures: ["promises_price_or_free"] });
  });

  test("a Haiku refusal fails, whether Jev reads it or the stop reason says so", async () => {
    expect((await verify("i can't help with that", { is_refusal: "yes" })).out.failures).toEqual(["refusal"]);
    expect((await verify("", {}, "reply", "refusal")).out.failures).toContain("refusal_stop");
  });

  test("explicit text, a meetup and an off-persona voice each fail", async () => {
    expect((await verify("x", { explicitness: "explicit" })).out.failures).toEqual(["explicit"]);
    expect((await verify("x", { offplatform_or_meetup: "yes" })).out.failures).toEqual(["offplatform_or_meetup"]);
    expect((await verify("x", { on_persona: "no" })).out.failures).toEqual(["off_persona"]);
  });

  test("admits_ai: required on ai_disclosure, forbidden on every other route", async () => {
    expect((await verify("i'm an ai", { admits_ai: "yes" }, "reply")).out.failures).toEqual(["admits_ai_unexpected"]);
    expect((await verify("i'm real", { admits_ai: "no" }, "ai_disclosure")).out.failures).toEqual(["admits_ai_missing"]);
    expect((await verify("i'm an ai", { admits_ai: "yes" }, "ai_disclosure")).out.ok).toBe(true);
    // Admitting it is out of character by definition, so the persona check does not fail a disclosure.
    expect((await verify("i'm an ai", { admits_ai: "yes", on_persona: "no" }, "ai_disclosure")).out.ok).toBe(true);
    expect((await verify("i'm an ai", { admits_ai: "yes", on_persona: "no", explicitness: "explicit" }, "ai_disclosure")).out.failures).toEqual(["explicit"]);
    for (const route of ["offer", "deflect", "reply"] as const) {
      expect((await verify("i'm an ai", { admits_ai: "yes" }, route)).out.ok).toBe(false);
    }
  });
});

describe("conversation checks", () => {
  test("reasks_is_quality_only", async () => {
    const { out } = await verify("wbu, what u up to", { reasks: "yes" });
    expect(out.failures).toEqual(["reasks"]);
    expect(out.ok).toBe(false);
    expect(qualityOnly(out.failures)).toBe(true);
    expect(qualityOnly(["reasks", "money"])).toBe(false);
    expect(qualityOnly([])).toBe(false);
  });

  test("missing_reasks_answer_counts_as_no", async () => {
    const decider = new FakeDecider({ script: { ...GOOD } });
    const real = decider.ask.bind(decider);
    decider.ask = async (qs, ctx) => {
      const r = await real(qs, ctx);
      return { ...r, answers: r.answers.filter((a) => a.key !== "reasks") };
    };
    const out = await verifyDraft(decider, { draft: "hey you", fanMessage: "hi", earlier: [], route: "reply", neverList: [], stopReason: "end_turn" }, () => 0);
    expect(out.ok).toBe(true);
  });

  test("marker_echo_fails_code_check", () => {
    for (const d of ["— 2 hours later — hey", "miss u\n— 38 minutes later —", "-- 1 day later --"]) {
      expect(codeChecks(d, [])).toContain("marker_echo");
    }
    expect(codeChecks("see you later, 2 hours is a lot", [])).toEqual([]);
  });

  test("the verify state carries the earlier messages", async () => {
    const { decider } = await verify("hey");
    expect(decider.calls[0].state).toMatchObject({ earlier_messages: [] });
  });
});

describe("an offer draft must lead into the item", () => {
  const item = { title: "The full set", teaser: "All three, plus a bonus" };
  async function offerVerify(leads: string, route: RouteName = "offer") {
    const decider = new FakeDecider({ script: { ...GOOD, leads_to_offer: leads } });
    const out = await verifyDraft(decider, { draft: "lmaooo ur mummy era", fanMessage: "hi", earlier: [], route, neverList: [], stopReason: "end_turn", offer: item }, () => 0);
    return { out, decider };
  }
  test("asked on an offer route, with the item in Jev's state", async () => {
    const { out, decider } = await offerVerify("yes");
    expect(out.ok).toBe(true);
    expect(decider.calls[0].keys).toContain("leads_to_offer");
    expect(JSON.stringify(decider.calls[0].state)).toContain("The full set: All three, plus a bonus");
  });
  test("a draft that never gets to the item fails as quality only: safe to send, not with the card", async () => {
    const { out } = await offerVerify("no");
    expect(out.failures).toEqual(["offer_unsetup"]);
    expect(qualityOnly(out.failures)).toBe(true);
    expect(qualityOnly(["offer_unsetup", "money"])).toBe(false);
  });
  test("not asked on any other route", async () => {
    const { out, decider } = await offerVerify("no", "reply");
    expect(out.ok).toBe(true);
    expect(decider.calls[0].keys).not.toContain("leads_to_offer");
  });
});
