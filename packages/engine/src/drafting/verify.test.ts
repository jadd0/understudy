import { describe, expect, test } from "vitest";
import { FakeDecider } from "../testing/fakes/decider.js";
import { codeChecks, drawFailures, enforceDraw, mentionsMoney, ownAccounts, pointsToBioLink, qualityOnly, verifyDraft } from "./verify.js";
import type { StyleRates } from "./style-draw.js";
import type { RouteName } from "../types.js";

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

describe("her own accounts and her bio link", () => {
  const CARD = [
    "## Identity",
    "- You are juno, listed as an Artist.",
    "- Your film photos go on a separate account, @junofilm. (src: profile)",
    "- Mail goes to a@b.com and never to @user.",
    "",
    "## Voice rules",
    "- Never start a reply with an @mention or the fan's handle, like @someone.",
  ].join("\n");

  test("ownAccounts reads the handles on the Identity lines only", () => {
    expect(ownAccounts(CARD)).toEqual(["@junofilm"]);
    expect(ownAccounts("## Voice rules\n- an @mention\n")).toEqual([]);
    expect(ownAccounts("## Identity\n- no handle here\n")).toEqual([]);
  });

  test("verifyDraft tells Jev which accounts are hers, and says nothing when the card names none", async () => {
    const decider = new FakeDecider({ script: GOOD });
    const base = { draft: "hey you", fanMessage: "hi", earlier: [], route: "reply" as RouteName, neverList: [], stopReason: "end_turn" };
    await verifyDraft(decider, { ...base, ownAccounts: ownAccounts(CARD) }, () => 0);
    expect((decider.calls[0].state as { her_accounts?: string[] }).her_accounts).toEqual(["@junofilm"]);
    await verifyDraft(decider, { ...base, ownAccounts: [] }, () => 0);
    expect(decider.calls[1].state).not.toHaveProperty("her_accounts");
  });

  test("codeChecks flags a pointer to her bio link and leaves her bio alone", () => {
    expect(codeChecks("link in bio babe", [])).toEqual(["bio_link"]);
    expect(codeChecks("the link's in my bio", [])).toEqual(["bio_link"]);
    expect(codeChecks("my bio says brighton", [])).toEqual([]);
    expect(pointsToBioLink("Links in the BIO")).toBe(true);
    expect(pointsToBioLink("a linked bio")).toBe(false);
  });

  test("a bio_link draft is a quality failure that still goes to Jev, whose safety verdict still fails it", async () => {
    expect(qualityOnly(["bio_link"])).toBe(true);
    const clean = await verify("link in bio babe");
    expect(clean.decider.calls).toHaveLength(1);
    expect(clean.out.failures).toEqual(["bio_link"]);
    const unsafe = await verify("link in bio babe", { offplatform_or_meetup: "yes" });
    expect(unsafe.out.failures).toEqual(["bio_link", "offplatform_or_meetup"]);
    expect(qualityOnly(unsafe.out.failures)).toBe(false);
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

describe("enforceDraw", () => {
  const none = { signoff: false, address: null, petName: false, emoji: true } as const;
  test("keeps a noun use at the start and never leaves a bubble of emoji or space only", () => {
    expect(enforceDraw("mate of mine runs that shop", none)).toBe("mate of mine runs that shop");
    expect(enforceDraw("mate's van, not mine", none)).toBe("mate's van, not mine");
    expect(enforceDraw("mate 😘", none)).toBe("mate 😘");
    expect(enforceDraw("hi\nmate 😘", none)).toBe("hi\nmate 😘");
  });
  test("strips a sign-off x and an edge address term the draw disallowed", () => {
    expect(enforceDraw("see you soon x", none)).toBe("see you soon");
    expect(enforceDraw("see you soon xx", none)).toBe("see you soon");
    expect(enforceDraw("night night x 💛", none)).toBe("night night 💛");
    expect(enforceDraw("hey, mate", none)).toBe("hey");
    expect(enforceDraw("ok mate!", none)).toBe("ok!");
    expect(enforceDraw("mate, that's mad", none)).toBe("that's mad");
    expect(enforceDraw("mate that's mad", none)).toBe("that's mad");
    expect(enforceDraw("babe, you're sweet", none)).toBe("you're sweet");
    expect(enforceDraw("proper tired babe x", none)).toBe("proper tired");
    expect(enforceDraw("first line mate\nsecond line x", none)).toBe("first line\nsecond line");
  });
  test("keeps what the draw allowed", () => {
    expect(enforceDraw("see you soon x", { ...none, signoff: true })).toBe("see you soon x");
    expect(enforceDraw("hey, mate", { ...none, address: "mate" })).toBe("hey, mate");
    expect(enforceDraw("babe, hi", { ...none, address: "babe" })).toBe("babe, hi");
    // an allowed babe does not allow mate
    expect(enforceDraw("babe, hi mate", { ...none, address: "babe" })).toBe("babe, hi");
  });
  test("never touches mid-sentence words or words that contain the term", () => {
    for (const t of ["checkmate", "merry xmas", "x marks the spot", "my mate Dave is mad", "a babe in the woods is odd", "xD", "mates"]) {
      expect(enforceDraw(t, none), t).toBe(t);
    }
    expect(enforceDraw("my mate said hi x", none)).toBe("my mate said hi");
    // an x that is not on the last bubble is not a sign-off
    expect(enforceDraw("ha x\nok", none)).toBe("ha x\nok");
  });
  test("a change that would empty the reply is not made", () => {
    expect(enforceDraw("x", none)).toBe("x");
    expect(enforceDraw("xx", none)).toBe("xx");
    expect(enforceDraw("mate", none)).toBe("mate");
    expect(enforceDraw("mate x", none)).toBe("mate");
  });
});

describe("enforceDraw: emoji and lines", () => {
  const quiet = { signoff: true, address: null, petName: false, emoji: false } as const;
  test("strips every emoji when the draw disallowed them, keeping the words", () => {
    expect(enforceDraw("haha stop 😂 you're mad 🙈", quiet)).toBe("haha stop you're mad");
    expect(enforceDraw("morning 👩🏽‍🎤\nbusy day 🇬🇧", quiet)).toBe("morning\nbusy day");
    expect(enforceDraw("haha 😂", { ...quiet, emoji: true })).toBe("haha 😂");
  });
  test("a reply that is only emoji is kept, as is a bubble of one", () => {
    expect(enforceDraw("🐕", quiet)).toBe("🐕");
    expect(enforceDraw("🐕🐕", quiet)).toBe("🐕🐕");
    expect(enforceDraw("😂\n🙈", quiet)).toBe("😂\n🙈");
  });
  test("joins lines with a space only when the draw said one line", () => {
    const one = { ...quiet, emoji: true, multiline: false };
    expect(enforceDraw("first bit\nsecond bit\n\nthird", one)).toBe("first bit second bit third");
    expect(enforceDraw("first bit\nsecond bit", { ...one, multiline: true })).toBe("first bit\nsecond bit");
    expect(enforceDraw("first bit\nsecond bit", { ...quiet, emoji: true })).toBe("first bit\nsecond bit");
  });
  test("a question is never stripped or emptied, whatever the draw", () => {
    expect(enforceDraw("you?", { ...quiet, question: false })).toBe("you?");
  });
});

describe("drawFailures", () => {
  const rates: StyleRates = { signoff_x: 0, mate: 0, babe: 0, pet_name: 0, emoji: 0, length: { p25: 23, p50: 30, p75: 35, p90: 42 }, pet: "biscuit" };
  const draw = { signoff: false, address: null, petName: false, emoji: false, targetChars: 20 } as const;
  test("too_long fires above max(2 x target, p90) and not at it, counting a line break as one space", () => {
    expect(drawFailures("a".repeat(42), draw, rates)).toEqual([]);
    expect(drawFailures("a".repeat(43), draw, rates)).toEqual(["too_long"]);
    expect(drawFailures(`${"a".repeat(21)}\n${"b".repeat(21)}`, draw, rates)).toEqual(["too_long"]);
    // a longer target raises the limit past p90
    expect(drawFailures("a".repeat(60), { ...draw, targetChars: 35 }, rates)).toEqual([]);
    expect(drawFailures("a".repeat(71), { ...draw, targetChars: 35 }, rates)).toEqual(["too_long"]);
  });
  test("a concrete price or shop under her p90 is not too long", () => {
    expect(drawFailures("it's the Co-op on Western Road", draw, rates)).toEqual([]);
  });
  test("pet_disallowed fires only when the pet is named and the draw did not allow it", () => {
    expect(drawFailures("biscuit says hi", draw, rates)).toEqual(["pet_disallowed"]);
    expect(drawFailures("Biscuit says hi", { ...draw, petName: true }, rates)).toEqual([]);
    expect(drawFailures("my dog says hi", draw, rates)).toEqual([]);
    expect(drawFailures("biscuit says hi", draw, { ...rates, pet: null })).toEqual([]);
  });
  test("both can fire, and nothing fires without a draw, a length or rates", () => {
    expect(drawFailures(`biscuit ${"a".repeat(60)}`, draw, rates)).toEqual(["too_long", "pet_disallowed"]);
    expect(drawFailures("a".repeat(200), null, rates)).toEqual([]);
    expect(drawFailures("a".repeat(200), draw, null)).toEqual([]);
    expect(drawFailures("a".repeat(200), { ...draw, targetChars: undefined }, rates)).toEqual([]);
    expect(drawFailures("a".repeat(200), draw, { ...rates, length: null })).toEqual([]);
  });
  test("both are quality-only: a draft failing only these may still be sent", () => {
    expect(qualityOnly(["too_long", "pet_disallowed"])).toBe(true);
    expect(qualityOnly(["too_long", "money"])).toBe(false);
  });
});
