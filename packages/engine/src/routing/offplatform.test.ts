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
    "give me your phone number",
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

  // Contact forms, obfuscated spellings and plans to meet that a plainer list would miss.
  const obfuscated = [
    "do you have cash app",
    "cash-app?",
    "cash   app me",
    "my c@shapp is $fan",
    "where do u live",
    "where ya live",
    "see you in real life",
    "ur digits?",
    "your num pls",
    "my number is 5551234",
    "dm me on insta",
    "dm me on instagram",
    "can i come to ur place",
    "your place or mine",
    "my place tonight",
    "add me on whats app",
    "what's app?",
    "WhatsApp",
    "wa me",
    "hmu on tg",
    "i'm on tele",
    "pp me",
    "can i pay with a gift card",
    "gift cards ok?",
    "usdc is fine",
    "send usdt",
    "let's meet",
    "lets meet",
    "can we meet up",
    "meet me",
    "wanna meet irl",
    "meet in person",
    "i'll meet you tonight",
    "tonight i could come round",
    "see you tonight",
    "come over tonight",
    "text me",
    "call me",
    "hmu on snap",
    "snap me",
    "my snap is juno",
    "ur snap?",
    "your snap",
    "dm on snap",
    "message me on snap",
    "snap: juno",
    "on signal",
    "signal app?",
  ];
  test.each(obfuscated)("flags %s", (text) => expect(offPlatformSignal(text)).toBe(true));

  // Ordinary talk that shares a word with an off-platform route.
  const ordinary = [
    "can i buy some snaps of u from this week",
    "got any snaps of the beach",
    "i sent a snap to my friend",
    "any signal on that one",
    "no signal where i am",
    "does the video play on my phone",
    "my phone died",
    "what number is that set",
    "pick a number between 1 and 10",
    "i like that number lol",
    "nice to meet you",
    "glad to meet you",
    "we should meet the deadline",
    "tonight is going to be a long one",
    "what are you doing tonight",
    "i have a place in the queue",
    "can i top up with apple pay?",
    "does google pay work for top ups",
    "that is a wise choice",
    "using wise judgement here",
    "use wise words babe",
    "to be honest i love it",
    "what's up",
    "he gave me a call yesterday",
    "in real terms",
  ];
  test.each(ordinary)("leaves %j alone", (text) => expect(offPlatformSignal(text)).toBe(false));

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
    expect(offPlatformSignal("meet up")).toBe(true);
    expect(offPlatformSignal("meetups")).toBe(true);
    expect(offPlatformSignal("meeting me")).toBe(false);
    expect(offPlatformSignal("snapped me")).toBe(false);
    expect(offPlatformSignal("signaling")).toBe(false);
    expect(offPlatformSignal("addressing it")).toBe(false);
    expect(offPlatformSignal("numbering them")).toBe(false);
  });
});

describe("namesPaymentApp", () => {
  test("names a payment route and nothing else", () => {
    expect(namesPaymentApp("just send it to my cashapp babe")).toBe(true);
    expect(namesPaymentApp("pay me direct")).toBe(true);
    expect(namesPaymentApp("smart and wise of you")).toBe(false);
    expect(namesPaymentApp("add me on snap")).toBe(false);
    expect(namesPaymentApp("i'd love to meet")).toBe(false);
  });
});

describe("namesPaymentApp: wise and in-app payment methods", () => {
  const payments = [
    "send it on wise",
    "pay me via wise",
    "do a wise transfer",
    "my wise account",
    "send it to wise",
    "send it through wise",
    "send it via wise",
    "send it on wise babe",
    "Wise Transfer please",
    "cash app",
    "cashapp",
    "cash-app",
    "c@shapp",
    "pp me",
    "gift card",
    "usdc",
    "apple cash",
  ];
  test.each(payments)("names a payment route in %j", (text) => expect(namesPaymentApp(text)).toBe(true));

  const notPayments = [
    "use wise words",
    "using wise judgement",
    "a wise choice",
    "wise guy",
    "yep apple pay works for top ups",
    "google pay works too",
    "apple pay",
    "you can top up with apple pay or a card",
    "likewise",
  ];
  test.each(notPayments)("does not name one in %j", (text) => expect(namesPaymentApp(text)).toBe(false));
});

describe("namesMessagingApp", () => {
  test("names a messaging app and nothing else", () => {
    expect(namesMessagingApp("- snap: @juno.priv")).toBe(true);
    expect(namesMessagingApp("WhatsApp")).toBe(true);
    expect(namesMessagingApp("- instagram: @juno")).toBe(false);
    expect(namesMessagingApp("cashapp")).toBe(false);
    expect(namesMessagingApp("- tg: @juno")).toBe(true);
    expect(namesMessagingApp("- tele: @juno")).toBe(true);
    expect(namesMessagingApp("- signal: +15550100")).toBe(true);
  });
});
