import { describe, expect, test } from "vitest";
import { inboundQuestions, VERIFY_QUESTIONS, VERIFY_QUESTIONS_PAID } from "./questions";

const prompt = (qs: { key: string; prompt: string }[], key: string) => qs.find((q) => q.key === key)?.prompt ?? "";

describe("engine questions", () => {
  test("asking for anything new or fresh is buy intent", () => {
    const intent = inboundQuestions({ offerResponse: false, pitchFit: false, paid: false }).find((q) => q.key === "intent");
    const buy = intent?.options.find((o) => o.key === "buy_intent")?.label ?? "";
    expect(buy).toContain("anything new or fresh");
  });

  test("every fan gets the loosened off-platform check: games and her public accounts pass, meetups and contact details fail", () => {
    for (const qs of [VERIFY_QUESTIONS, VERIFY_QUESTIONS_PAID]) {
      const q = prompt(qs, "offplatform_or_meetup");
      expect(q).toContain("meet in person");
      expect(q).toContain("phone number, email or private account");
      expect(q).toContain("saying where she streams or posts, is fine");
    }
    const inbound = prompt(inboundQuestions({ offerResponse: false, pitchFit: false, paid: false }), "location_offplatform");
    expect(inbound).toContain("An invite to play an online game or do something online together is not");
  });

});
