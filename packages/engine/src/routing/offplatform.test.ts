import { describe, expect, test } from "vitest";
import { namesMessagingApp, namesPaymentApp, offPlatformSignal } from "./offplatform.js";

describe("offPlatformSignal", () => {
  const hits = [
    "i'll pay you $500 to meet me tonight",
    "can i pay on cashapp for a set",
    "my CashApp is $fan",
    "do you take venmo",
    "paypal me",
    "zelle?",
    "revolut works",
    "bank transfer ok?",
    "i can pay in crypto",
    "send btc",
    "pay you direct instead",
    "i'll pay you directly",
    "pay you outside the app",
    "add me on snap",
    "whats your snapchat",
    "telegram?",
    "whatsapp me",
    "kik",
    "join my discord",
    "text me on signal",
    "whats your number",
    "give me your phone",
    "whats your email",
    "come over tonight",
    "wanna meet",
    "lets do a meetup",
    "irl?",
    "see you in person",
    "whats your address",
    "where do you live",
    "which hotel",
  ];
  test.each(hits)("flags %s", (text) => expect(offPlatformSignal(text)).toBe(true));

  const clean = [
    "got any sets i can buy?",
    "got any sets i can buy? the one with the meeting-room lighting looked great",
    "show me something new",
    "i snapped out of it lol",
    "that's a wise choice",
    "the sets were a nice find, i'd buy another",
    "what did you do today",
    "",
  ];
  test.each(clean)("leaves %j alone", (text) => expect(offPlatformSignal(text)).toBe(false));

  test("whole-word matching: a longer word that contains a term is not a hit", () => {
    expect(offPlatformSignal("meeting")).toBe(false);
    expect(offPlatformSignal("meet")).toBe(true);
    expect(offPlatformSignal("signaling")).toBe(false);
    expect(offPlatformSignal("addressing it")).toBe(false);
    expect(offPlatformSignal("numbering them")).toBe(false);
  });
});

describe("namesPaymentApp", () => {
  test("names a payment route and nothing else", () => {
    expect(namesPaymentApp("just send it to my cashapp babe")).toBe(true);
    expect(namesPaymentApp("pay me direct")).toBe(true);
    expect(namesPaymentApp("use wise for that")).toBe(true);
    expect(namesPaymentApp("smart and wise of you")).toBe(false);
    expect(namesPaymentApp("add me on snap")).toBe(false);
    expect(namesPaymentApp("i'd love to meet")).toBe(false);
  });
});

describe("namesMessagingApp", () => {
  test("names a messaging app and nothing else", () => {
    expect(namesMessagingApp("- snap: @juno.priv")).toBe(true);
    expect(namesMessagingApp("WhatsApp")).toBe(true);
    expect(namesMessagingApp("- instagram: @juno")).toBe(false);
    expect(namesMessagingApp("cashapp")).toBe(false);
  });
});
