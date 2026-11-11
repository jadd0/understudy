import { describe, expect, test } from "vitest";
import { disabledChecks, inboundQuestions, VERIFY_QUESTIONS } from "./questions.js";

const prompt = (qs: { key: string; prompt: string }[], key: string) => qs.find((q) => q.key === key)?.prompt ?? "";

describe("engine questions", () => {
  test("asking for anything new or fresh is buy intent", () => {
    const intent = inboundQuestions({ offerResponse: false, pitchFit: false, paid: false }).find((q) => q.key === "intent");
    const buy = intent?.options.find((o) => o.key === "buy_intent")?.label ?? "";
    expect(buy).toContain("anything new or fresh");
  });

  test("every fan gets the loosened off-platform check: games and her public accounts pass, meetups, contact details and paying her off the app fail", () => {
    const q = prompt(VERIFY_QUESTIONS, "offplatform_or_meetup");
    expect(q).toContain("meet in person");
    expect(q).toContain("phone number, email or private account");
    expect(q).toContain("pay her outside this app");
    expect(q).toContain("payment app");
    expect(q).toContain("saying where she streams or posts, is fine");
    expect(VERIFY_QUESTIONS.filter((x) => x.key === "offplatform_or_meetup")).toHaveLength(1);
    const inbound = prompt(inboundQuestions({ offerResponse: false, pitchFit: false, paid: false }), "location_offplatform");
    expect(inbound).toContain("An invite to play an online game or do something online together is not");
  });


  test("every safety question is asked by default and a disabled check's question is left out", () => {
    const all = inboundQuestions({ offerResponse: false, pitchFit: false }).map((q) => q.key);
    for (const k of ["minor", "self_harm", "threat", "location_offplatform", "payment_dispute", "hardship"]) expect(all).toContain(k);
    const some = inboundQuestions({ offerResponse: false, pitchFit: false, disabled: ["minor", "threat"] }).map((q) => q.key);
    expect(some).not.toContain("minor");
    expect(some).not.toContain("threat");
    expect(some).toEqual(all.filter((k) => k !== "minor" && k !== "threat"));
    expect(disabledChecks({ minor: false, self_harm: true, threat: true, location_offplatform: false, payment_dispute: true })).toEqual(["minor", "location_offplatform"]);
  });
});
